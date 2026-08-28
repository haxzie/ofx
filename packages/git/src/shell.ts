import { Bash } from "just-bash/browser";
import type { CustomCommand, IFileSystem } from "just-bash/browser";
import { DEFAULT_WORKSPACE } from "./engine.js";

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ShellRunOptions {
  signal?: AbortSignal;
  stdin?: string;
}

export interface ShellOptions {
  fs: IFileSystem;
  cwd?: string;
  env?: Record<string, string>;
  customCommands?: CustomCommand[];
  /** Cap on retained history entries. */
  maxHistory?: number;
}

/**
 * A latin1-shaped byte string (one char per byte) decoded as UTF-8.
 *
 * just-bash exports `decodeBytesToUtf8` from its Node entry only, so the
 * browser build needs its own copy.
 */
function decodeLatin1(value: string): string {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) bytes[i] = value.charCodeAt(i) & 0xff;
  return new TextDecoder().decode(bytes);
}

/**
 * A persistent shell session over a virtual filesystem.
 *
 * `Bash.exec()` gives every call an isolated shell state — cwd, exported
 * variables, aliases and functions are all discarded when it returns, and
 * `bash.getCwd()` stays frozen at the constructor value. Only the filesystem
 * genuinely persists. So the session state machine lives here: cwd, env and
 * history are held on this object and threaded through each `exec` call, with
 * `result.env.PWD` read back to carry the working directory forward.
 */
export class Shell {
  readonly bash: Bash;

  private readonly initialCwd: string;
  private readonly initialEnv: Record<string, string>;
  private readonly maxHistory: number;

  private currentCwd: string;
  private currentEnv: Record<string, string>;
  private readonly commandHistory: string[] = [];

  constructor(options: ShellOptions) {
    this.initialCwd = options.cwd ?? DEFAULT_WORKSPACE;
    this.initialEnv = { HOME: "/home/user", ...options.env };
    this.maxHistory = options.maxHistory ?? 1000;
    this.currentCwd = this.initialCwd;
    this.currentEnv = { ...this.initialEnv };

    this.bash = new Bash({
      fs: options.fs,
      cwd: this.initialCwd,
      env: this.initialEnv,
      customCommands: options.customCommands,
    });
  }

  get cwd(): string {
    return this.currentCwd;
  }

  get env(): Readonly<Record<string, string>> {
    return this.currentEnv;
  }

  get history(): readonly string[] {
    return this.commandHistory;
  }

  /** Reset cwd, env and history. The filesystem is untouched. */
  reset(): void {
    this.currentCwd = this.initialCwd;
    this.currentEnv = { ...this.initialEnv };
    this.commandHistory.length = 0;
  }

  async run(line: string, options: ShellRunOptions = {}): Promise<ShellResult> {
    const command = line.trim();
    if (command === "") return { stdout: "", stderr: "", exitCode: 0 };

    this.commandHistory.push(command);
    if (this.commandHistory.length > this.maxHistory) {
      this.commandHistory.splice(0, this.commandHistory.length - this.maxHistory);
    }

    const result = await this.bash.exec(command, {
      cwd: this.currentCwd,
      // `history` is env-backed in just-bash: it reads BASH_HISTORY as a JSON
      // array, so the host owns the list and injects it per call.
      env: { ...this.currentEnv, BASH_HISTORY: JSON.stringify(this.commandHistory) },
      signal: options.signal,
      stdin: options.stdin,
    });

    // Carry session state forward — this is what Bash.exec deliberately drops.
    this.currentEnv = { ...result.env };
    this.currentCwd = result.env.PWD ?? this.currentCwd;
    if (result.env.BASH_HISTORY !== undefined) {
      try {
        const next = JSON.parse(result.env.BASH_HISTORY) as unknown;
        // `history -c` clears the injected array; honour it.
        if (Array.isArray(next) && next.length === 0) this.commandHistory.length = 0;
      } catch {
        // A malformed value is not worth failing the command over.
      }
    }

    const isBytes = result.stdoutKind === "bytes" || result.stdoutEncoding === "binary";
    return {
      stdout: isBytes ? decodeLatin1(result.stdout) : result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }
}

export function createShell(options: ShellOptions): Shell {
  return new Shell(options);
}
