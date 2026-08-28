import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { PersistentFs } from "../src/fs/persistent-fs.js";

let dbCounter = 0;
/** A fresh IndexedDB database per test, so cases cannot leak into each other. */
function freshDb(): string {
  dbCounter += 1;
  return `wowsm-test-${dbCounter}`;
}

describe("PersistentFs — IFileSystem contract", () => {
  let fs: PersistentFs;

  beforeEach(() => {
    fs = new PersistentFs({ persist: false });
  });

  it("round-trips file content", async () => {
    await fs.mkdir("/workspace", { recursive: true });
    await fs.writeFile("/workspace/a.txt", "hello");
    expect(await fs.readFile("/workspace/a.txt")).toBe("hello");
    expect(await fs.exists("/workspace/a.txt")).toBe(true);
  });

  it("keeps resolvePath and getAllPaths synchronous", async () => {
    await fs.mkdir("/workspace/sub", { recursive: true });
    await fs.writeFile("/workspace/sub/b.txt", "b");

    // Not a promise — globbing in just-bash depends on these being sync.
    const resolved = fs.resolvePath("/workspace", "sub/b.txt");
    expect(resolved).toBe("/workspace/sub/b.txt");
    expect(fs.getAllPaths()).toEqual(expect.arrayContaining(["/workspace/sub/b.txt"]));
  });

  it("reports directories, files and symlinks via lstat", async () => {
    await fs.mkdir("/workspace", { recursive: true });
    await fs.writeFile("/workspace/target.txt", "t");
    await fs.symlink("/workspace/target.txt", "/workspace/link.txt");

    expect((await fs.lstat("/workspace")).isDirectory).toBe(true);
    expect((await fs.lstat("/workspace/target.txt")).isFile).toBe(true);
    expect((await fs.lstat("/workspace/link.txt")).isSymbolicLink).toBe(true);
    expect(await fs.readlink("/workspace/link.txt")).toBe("/workspace/target.txt");
  });
});

describe("PersistentFs — change notification", () => {
  it("reports mutated paths and their ancestors", async () => {
    const fs = new PersistentFs({ persist: false, notifyDelayMs: 0 });
    const seen: string[] = [];
    fs.onChange((paths) => seen.push(...paths));

    await fs.mkdir("/workspace/deep", { recursive: true });
    await fs.writeFile("/workspace/deep/file.txt", "x");
    await new Promise((r) => setTimeout(r, 10));

    expect(seen).toEqual(expect.arrayContaining(["/workspace/deep/file.txt", "/workspace/deep", "/workspace"]));
  });

  it("stops notifying after unsubscribe", async () => {
    const fs = new PersistentFs({ persist: false, notifyDelayMs: 0 });
    const seen: string[] = [];
    const off = fs.onChange((paths) => seen.push(...paths));
    off();

    await fs.mkdir("/w", { recursive: true });
    await fs.writeFile("/w/a", "a");
    await new Promise((r) => setTimeout(r, 10));

    expect(seen).toEqual([]);
  });
});

describe("PersistentFs — IndexedDB persistence", () => {
  it("survives a reload (hydrate into a fresh instance)", async () => {
    const dbName = freshDb();

    const first = new PersistentFs({ dbName, flushDelayMs: 0 });
    expect(first.persistent).toBe(true);
    await first.mkdir("/workspace/nested", { recursive: true });
    await first.writeFile("/workspace/nested/file.txt", "persisted content");
    await first.writeFile("/workspace/root.txt", "root");
    await first.mkdir("/workspace/empty-dir", { recursive: true });
    await first.flush();

    // A new instance is what a page reload produces.
    const second = new PersistentFs({ dbName });
    await second.hydrate();

    expect(await second.readFile("/workspace/nested/file.txt")).toBe("persisted content");
    expect(await second.readFile("/workspace/root.txt")).toBe("root");
    expect((await second.lstat("/workspace/empty-dir")).isDirectory).toBe(true);
  });

  it("persists binary content byte-for-byte", async () => {
    const dbName = freshDb();
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);

    const first = new PersistentFs({ dbName, flushDelayMs: 0 });
    await first.mkdir("/workspace", { recursive: true });
    await first.writeFile("/workspace/blob.bin", bytes);
    await first.flush();

    const second = new PersistentFs({ dbName });
    await second.hydrate();
    expect(Array.from(await second.readFileBuffer("/workspace/blob.bin"))).toEqual(Array.from(bytes));
  });

  it("propagates deletions, including whole subtrees", async () => {
    const dbName = freshDb();

    const first = new PersistentFs({ dbName, flushDelayMs: 0 });
    await first.mkdir("/workspace/tree/inner", { recursive: true });
    await first.writeFile("/workspace/tree/inner/deep.txt", "deep");
    await first.writeFile("/workspace/tree/shallow.txt", "shallow");
    await first.writeFile("/workspace/keep.txt", "keep");
    await first.flush();

    await first.rm("/workspace/tree", { recursive: true });
    await first.flush();

    const second = new PersistentFs({ dbName });
    await second.hydrate();
    expect(await second.exists("/workspace/keep.txt")).toBe(true);
    expect(await second.exists("/workspace/tree")).toBe(false);
    expect(await second.exists("/workspace/tree/inner/deep.txt")).toBe(false);
  });

  it("follows a subtree through mv", async () => {
    const dbName = freshDb();

    const first = new PersistentFs({ dbName, flushDelayMs: 0 });
    await first.mkdir("/workspace/from/inner", { recursive: true });
    await first.writeFile("/workspace/from/inner/f.txt", "moved");
    await first.flush();

    await first.mv("/workspace/from", "/workspace/to");
    await first.flush();

    const second = new PersistentFs({ dbName });
    await second.hydrate();
    expect(await second.readFile("/workspace/to/inner/f.txt")).toBe("moved");
    expect(await second.exists("/workspace/from/inner/f.txt")).toBe(false);
  });

  it("clears memory and storage on reset", async () => {
    const dbName = freshDb();

    const first = new PersistentFs({ dbName, flushDelayMs: 0 });
    await first.mkdir("/workspace", { recursive: true });
    await first.writeFile("/workspace/gone.txt", "gone");
    await first.flush();
    await first.reset();

    expect(first.getAllPaths()).toEqual([]);

    const second = new PersistentFs({ dbName });
    await second.hydrate();
    expect(await second.exists("/workspace/gone.txt")).toBe(false);
  });
});
