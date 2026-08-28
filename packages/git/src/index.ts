export { PersistentFs } from "./fs/persistent-fs.js";
export type {
  DirentEntry,
  FsChangeListener,
  PersistedRecord,
  PersistentFsOptions,
  ReadFileOptions,
  WriteFileOptions,
} from "./fs/persistent-fs.js";

export { createGitEngine, DEFAULT_CORS_PROXY, DEFAULT_WORKSPACE } from "./engine.js";
export type { GitEngineOptions, GitIdentity } from "./engine.js";

export { createShell, Shell } from "./shell.js";
export type { ShellOptions, ShellResult, ShellRunOptions } from "./shell.js";

export { getStatus } from "./status.js";
export type { FileState, FileStatus, StatusContext } from "./status.js";

export { createWorkspace } from "./workspace.js";
export type { CreateWorkspaceOptions, Workspace } from "./workspace.js";
