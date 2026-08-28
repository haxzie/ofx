import { InMemoryFs } from "just-bash/browser";
import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  InitialFiles,
  MkdirOptions,
  RmOptions,
} from "just-bash/browser";

// Not re-exported from just-bash's browser entry, but part of the IFileSystem
// contract; mirrored here rather than deep-importing past the exports map.
export interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}
export interface WriteFileOptions {
  encoding?: BufferEncoding;
}
export interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}
import {
  clear as idbClear,
  createStore,
  delMany,
  entries as idbEntries,
  setMany,
  type UseStore,
} from "idb-keyval";

/** One filesystem entry as stored in IndexedDB. */
export interface PersistedRecord {
  type: "file" | "directory" | "symlink";
  /** Present for `file`. */
  content?: Uint8Array;
  /** Present for `symlink`. */
  target?: string;
  mode: number;
  /** Epoch milliseconds — `Date` survives structured clone, but a number is cheaper. */
  mtime: number;
}

export interface PersistentFsOptions {
  /** IndexedDB database name. Ignored when `persist` is false. */
  dbName?: string;
  /**
   * Persist to IndexedDB. Defaults to true in the browser, false everywhere
   * else (Node tests, SSR) so the class is usable without a fake IDB.
   */
  persist?: boolean;
  /** Debounce before writing dirty paths to IndexedDB. */
  flushDelayMs?: number;
  /** Debounce before notifying change listeners. */
  notifyDelayMs?: number;
  initialFiles?: InitialFiles;
}

export type FsChangeListener = (paths: readonly string[]) => void;

const DEFAULTS = {
  dbName: "wowsm-vfs",
  flushDelayMs: 250,
  notifyDelayMs: 30,
} as const;

function idbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

/**
 * `IFileSystem` backed by just-bash's `InMemoryFs`, with a write-behind mirror
 * in IndexedDB.
 *
 * The in-memory tree is the source of truth. That is deliberate: `resolvePath`
 * and `getAllPaths` are synchronous in `IFileSystem` (globbing depends on them),
 * so a directly IndexedDB-backed filesystem cannot satisfy the interface.
 *
 * Mutations mark paths dirty and are flushed on a debounce. Subtree operations
 * (`rm -r`, `cp -r`, `mv`) expand to the set of paths they actually touched.
 */
export class PersistentFs implements IFileSystem {
  /** The underlying in-memory tree. Exposed for tests and bulk seeding. */
  readonly inner: InMemoryFs;

  private readonly store: UseStore | null;
  private readonly flushDelayMs: number;
  private readonly notifyDelayMs: number;

  private readonly dirty = new Set<string>();
  private readonly pendingNotify = new Set<string>();
  private readonly listeners = new Set<FsChangeListener>();

  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  /** Chains flushes so two overlapping debounces cannot interleave writes. */
  private flushChain: Promise<void> = Promise.resolve();

  constructor(options: PersistentFsOptions = {}) {
    const persist = options.persist ?? idbAvailable();
    this.inner = new InMemoryFs(options.initialFiles);
    this.store = persist && idbAvailable() ? createStore(options.dbName ?? DEFAULTS.dbName, "files") : null;
    this.flushDelayMs = options.flushDelayMs ?? DEFAULTS.flushDelayMs;
    this.notifyDelayMs = options.notifyDelayMs ?? DEFAULTS.notifyDelayMs;
  }

  /** True when this instance mirrors to IndexedDB. */
  get persistent(): boolean {
    return this.store !== null;
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Load the persisted tree into memory. Call once before handing the
   * filesystem to the shell or git engine. Does nothing when not persistent.
   */
  async hydrate(): Promise<void> {
    if (!this.store) return;
    const records = (await idbEntries(this.store)) as [string, PersistedRecord][];
    if (records.length === 0) return;

    // Directories first, shallowest to deepest, so children always have a parent.
    const dirs = records.filter(([, r]) => r.type === "directory").sort((a, b) => a[0].length - b[0].length);
    const files = records.filter(([, r]) => r.type === "file");
    const links = records.filter(([, r]) => r.type === "symlink");

    for (const [path] of dirs) {
      this.inner.mkdirSync(path, { recursive: true });
    }
    for (const [path, r] of files) {
      this.inner.writeFileSync(path, r.content ?? new Uint8Array(), undefined, {
        mode: r.mode,
        mtime: new Date(r.mtime),
      });
    }
    // Symlinks last: their targets may be entries created above.
    for (const [path, r] of links) {
      try {
        await this.inner.symlink(r.target ?? "", path);
      } catch {
        // A dangling or already-present link must not abort hydration.
      }
    }
  }

  /** Flush any pending writes and wait for IndexedDB to settle. */
  async flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.scheduleFlushNow();
    await this.flushChain;
  }

  /** Drop everything — memory and IndexedDB. */
  async reset(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.dirty.clear();
    const paths = this.inner.getAllPaths();
    for (const path of paths) {
      try {
        await this.inner.rm(path, { recursive: true, force: true });
      } catch {
        // Already removed as part of an earlier subtree.
      }
    }
    if (this.store) await idbClear(this.store);
    this.notify(paths);
  }

  onChange(listener: FsChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ------------------------------------------------------------- dirty tracking

  private pathsUnder(path: string): string[] {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    return this.inner.getAllPaths().filter((p) => p === path || p.startsWith(prefix));
  }

  /** Mark a path plus its ancestors (mkdir -p and writes create parents). */
  private mark(path: string): void {
    let p = path;
    for (;;) {
      this.dirty.add(p);
      this.pendingNotify.add(p);
      const slash = p.lastIndexOf("/");
      if (slash <= 0) break;
      p = p.slice(0, slash);
    }
    this.schedule();
  }

  private markAll(paths: Iterable<string>): void {
    for (const p of paths) {
      this.dirty.add(p);
      this.pendingNotify.add(p);
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.store && this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.scheduleFlushNow();
      }, this.flushDelayMs);
    }
    if (this.listeners.size > 0 && this.notifyTimer === null) {
      this.notifyTimer = setTimeout(() => {
        this.notifyTimer = null;
        const paths = [...this.pendingNotify];
        this.pendingNotify.clear();
        this.notify(paths);
      }, this.notifyDelayMs);
    }
  }

  private notify(paths: readonly string[]): void {
    if (paths.length === 0) return;
    for (const listener of this.listeners) listener(paths);
  }

  private scheduleFlushNow(): void {
    if (!this.store || this.dirty.size === 0) return;
    const paths = [...this.dirty];
    this.dirty.clear();
    this.flushChain = this.flushChain.then(() => this.writeBatch(paths)).catch((err) => {
      console.error("[wowsm] IndexedDB flush failed", err);
    });
  }

  private async writeBatch(paths: readonly string[]): Promise<void> {
    if (!this.store) return;
    const puts: [string, PersistedRecord][] = [];
    const dels: string[] = [];

    for (const path of paths) {
      let st: FsStat;
      try {
        st = await this.inner.lstat(path);
      } catch {
        dels.push(path);
        continue;
      }
      const base = { mode: st.mode, mtime: st.mtime.getTime() };
      if (st.isDirectory) {
        puts.push([path, { type: "directory", ...base }]);
      } else if (st.isSymbolicLink) {
        puts.push([path, { type: "symlink", target: await this.inner.readlink(path), ...base }]);
      } else {
        puts.push([path, { type: "file", content: await this.inner.readFileBuffer(path), ...base }]);
      }
    }

    if (puts.length > 0) await setMany(puts, this.store);
    if (dels.length > 0) await delMany(dels, this.store);
  }

  // ------------------------------------------------------------------- reads

  readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    return this.inner.readFile(path, options);
  }

  readFileBytes(path: string): ReturnType<InMemoryFs["readFileBytes"]> {
    return this.inner.readFileBytes(path);
  }

  readFileBuffer(path: string): Promise<Uint8Array> {
    return this.inner.readFileBuffer(path);
  }

  exists(path: string): Promise<boolean> {
    return this.inner.exists(path);
  }

  stat(path: string): Promise<FsStat> {
    return this.inner.stat(path);
  }

  lstat(path: string): Promise<FsStat> {
    return this.inner.lstat(path);
  }

  readdir(path: string): Promise<string[]> {
    return this.inner.readdir(path);
  }

  readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    return this.inner.readdirWithFileTypes(path);
  }

  readlink(path: string): Promise<string> {
    return this.inner.readlink(path);
  }

  realpath(path: string): Promise<string> {
    return this.inner.realpath(path);
  }

  /** Synchronous by contract — delegates straight to the in-memory tree. */
  resolvePath(base: string, path: string): string {
    return this.inner.resolvePath(base, path);
  }

  /** Synchronous by contract — this is why the tree must live in memory. */
  getAllPaths(): string[] {
    return this.inner.getAllPaths();
  }

  // ------------------------------------------------------------------ writes

  async writeFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    await this.inner.writeFile(path, content, options);
    this.mark(path);
  }

  async appendFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    await this.inner.appendFile(path, content, options);
    this.mark(path);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await this.inner.mkdir(path, options);
    this.mark(path);
  }

  async chmod(path: string, mode: number): Promise<void> {
    await this.inner.chmod(path, mode);
    this.mark(path);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await this.inner.symlink(target, linkPath);
    this.mark(linkPath);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    await this.inner.link(existingPath, newPath);
    this.mark(newPath);
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    await this.inner.utimes(path, atime, mtime);
    this.mark(path);
  }

  // -------------------------------------------------- subtree-affecting writes

  async rm(path: string, options?: RmOptions): Promise<void> {
    const affected = this.pathsUnder(path);
    await this.inner.rm(path, options);
    this.markAll(affected);
    this.mark(path);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    await this.inner.cp(src, dest, options);
    this.markAll(this.pathsUnder(dest));
    this.mark(dest);
  }

  async mv(src: string, dest: string): Promise<void> {
    const before = this.pathsUnder(src);
    await this.inner.mv(src, dest);
    this.markAll(before);
    this.markAll(this.pathsUnder(dest));
    this.mark(dest);
  }
}
