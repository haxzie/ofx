import type { Git } from "just-git";
import type { IFileSystem } from "just-bash/browser";

export type FileState =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted";

/** One changed file, shaped for the file tree's `+N −M` decorations. */
export interface FileStatus {
  path: string;
  state: FileState;
  /** Lines added across staged and unstaged changes. `-1` for binary. */
  added: number;
  /** Lines removed across staged and unstaged changes. `-1` for binary. */
  removed: number;
  staged: boolean;
  unstaged: boolean;
}

export interface StatusContext {
  fs: IFileSystem;
  cwd: string;
}

interface NumStat {
  added: number;
  removed: number;
}

/** `added\tremoved\tpath`, where `-` in either column means binary. */
function parseNumStat(stdout: string): Map<string, NumStat> {
  const out = new Map<string, NumStat>();
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [addedRaw, removedRaw, ...rest] = parts;
    // Renames render as `old => new`; the last field is the current path.
    const path = rest.join("\t");
    const added = addedRaw === "-" ? -1 : Number.parseInt(addedRaw ?? "0", 10);
    const removed = removedRaw === "-" ? -1 : Number.parseInt(removedRaw ?? "0", 10);
    out.set(path, {
      added: Number.isNaN(added) ? 0 : added,
      removed: Number.isNaN(removed) ? 0 : removed,
    });
  }
  return out;
}

function stateFor(index: string, worktree: string): FileState {
  if (index === "?" && worktree === "?") return "untracked";
  if (index === "U" || worktree === "U" || (index === "A" && worktree === "A") || (index === "D" && worktree === "D")) {
    return "conflicted";
  }
  if (index === "R") return "renamed";
  if (index === "A") return "added";
  if (index === "D" || worktree === "D") return "deleted";
  return "modified";
}

/** Count lines the way `git diff --numstat` would for a brand-new file. */
async function countLines(fs: IFileSystem, path: string): Promise<number> {
  try {
    const content = await fs.readFile(path);
    if (content === "") return 0;
    const newlines = content.split("\n").length - 1;
    return content.endsWith("\n") ? newlines : newlines + 1;
  } catch {
    return 0;
  }
}

/**
 * Working-tree status with per-file line deltas.
 *
 * Combines `status --porcelain` with staged and unstaged `diff --numstat`, and
 * falls back to counting lines directly for untracked files, which never
 * appear in a diff.
 */
export async function getStatus(git: Git, ctx: StatusContext): Promise<FileStatus[]> {
  const { fs, cwd } = ctx;
  const [statusResult, unstaged, staged] = await Promise.all([
    git.exec("status --porcelain", { fs, cwd }),
    git.exec("diff --numstat", { fs, cwd }),
    git.exec("diff --numstat --cached", { fs, cwd }),
  ]);

  if (statusResult.exitCode !== 0) return [];

  const unstagedStats = parseNumStat(unstaged.stdout);
  const stagedStats = parseNumStat(staged.stdout);

  const results: FileStatus[] = [];
  for (const line of statusResult.stdout.split("\n")) {
    if (line.length < 3) continue;
    const index = line[0] ?? " ";
    const worktree = line[1] ?? " ";
    let path = line.slice(3).trim();

    // `R  old -> new` — track the destination.
    const arrow = path.indexOf(" -> ");
    if (arrow !== -1) path = path.slice(arrow + 4);
    path = path.replace(/^"|"$/g, "");

    const state = stateFor(index, worktree);
    const a = unstagedStats.get(path);
    const b = stagedStats.get(path);

    let added = 0;
    let removed = 0;
    if (a?.added === -1 || b?.added === -1) {
      added = -1;
      removed = -1;
    } else {
      added = (a?.added ?? 0) + (b?.added ?? 0);
      removed = (a?.removed ?? 0) + (b?.removed ?? 0);
    }

    if (state === "untracked") {
      added = await countLines(fs, fs.resolvePath(cwd, path));
      removed = 0;
    }

    results.push({
      path,
      state,
      added,
      removed,
      staged: index !== " " && index !== "?",
      unstaged: worktree !== " " && worktree !== "?",
    });
  }

  return results;
}
