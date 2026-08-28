import type { CustomCommand, IFileSystem } from "just-bash/browser";
import type { Git } from "just-git";
import { createGitEngine, DEFAULT_WORKSPACE, type GitEngineOptions } from "./engine.js";
import { PersistentFs, type PersistentFsOptions } from "./fs/persistent-fs.js";
import { createShell, Shell } from "./shell.js";
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
  const { root = DEFAULT_WORKSPACE, fs: fsOptions, customCommands = [], ...engineOptions } = options;

  const fs = new PersistentFs(fsOptions);
  await fs.hydrate();
  if (!(await fs.exists(root))) await fs.mkdir(root, { recursive: true });

  const git = createGitEngine({ ...engineOptions, fs: fs as IFileSystem, cwd: root });

  const shell = createShell({
    fs,
    cwd: root,
    // just-git's `Git` is structurally a just-bash `Command`, but each package
    // declares its own `CommandContext`, so the structural match needs a cast.
    customCommands: [git as unknown as CustomCommand, ...customCommands],
  });

  return {
    fs,
    git,
    shell,
    root,
    status: () => getStatus(git, { fs, cwd: root }),
  };
}
