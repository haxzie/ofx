import type { CustomCommand, IFileSystem } from "just-bash/browser";
import type { Git } from "just-git";
import {
  createGitEngine,
  DEFAULT_WORKSPACE,
  withoutSymlinks,
  type GitEngineOptions,
} from "./engine.js";
import { PersistentFs, type PersistentFsOptions } from "./fs/persistent-fs.js";
import { createShell, Shell } from "./shell.js";
import { createGhCommand, type GhOptions } from "./gh/index.js";
import { getStatus, type FileStatus } from "./status.js";

export interface Workspace {
  fs: PersistentFs;
  git: Git;
  shell: Shell;
  /** Absolute path the shell and git treat as the repository root. */
  root: string;
  /** Working-tree status, shaped for file-tree decorations. */
  status(): Promise<FileStatus[]>;
}

export interface CreateWorkspaceOptions extends Omit<GitEngineOptions, "fs" | "cwd"> {
  /** Defaults to `/workspace`. */
  root?: string;
  /** Passed through to `PersistentFs`. */
  fs?: PersistentFsOptions;
  /** Extra shell commands registered alongside `git`. */
  customCommands?: CustomCommand[];
  /** GitHub CLI options, or `false` to leave `gh` unregistered. */
  gh?: GhOptions | false;
}

/**
 * Build a ready-to-use browser workspace: a persistent virtual filesystem with
 * git and a bash session sharing it.
 *
 * The single shared `IFileSystem` is the whole point — just-bash defines the
 * interface and just-git accepts it structurally, so the shell, git, and any
 * file-tree UI all observe exactly the same tree.
 */
export async function createWorkspace(options: CreateWorkspaceOptions = {}): Promise<Workspace> {
  const {
    root = DEFAULT_WORKSPACE,
    fs: fsOptions,
    customCommands = [],
    gh = {},
    ...engineOptions
  } = options;

  const fs = new PersistentFs(fsOptions);
  await fs.hydrate();
  if (!(await fs.exists(root))) await fs.mkdir(root, { recursive: true });

  const git = createGitEngine({ ...engineOptions, fs, cwd: root });

  const shell = createShell({
    fs,
    cwd: root,
    // just-git's `Git` is structurally a just-bash `Command`, but each package
    // declares its own `CommandContext`, so the structural match needs a cast.
    //
    // The context's `fs` overrides whatever the engine was built with, so the
    // symlink-free view has to be applied here too — this is the filesystem
    // git actually checks out through when driven from the shell.
    customCommands: [
      {
        name: "git",
        execute: (args: string[], ctx: { fs: IFileSystem }) =>
          (git as unknown as CustomCommand & {
            execute: (a: string[], c: unknown) => Promise<unknown>;
          }).execute(args, { ...ctx, fs: withoutSymlinks(ctx.fs) }),
      } as unknown as CustomCommand,
      // gh authenticates through the same resolver as git, so signing in
      // lights up both without extra wiring.
      ...(gh === false
        ? []
        : [
            createGhCommand({
              token: async () => {
                const value = engineOptions.token;
                return typeof value === "function" ? await value() : value;
              },
              ...gh,
            }),
          ]),
      ...customCommands,
    ],
  });

  return {
    fs,
    git,
    shell,
    root,
    status: () => getStatus(git, { fs, cwd: root }),
  };
}
