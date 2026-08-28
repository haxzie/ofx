import { useMemo, useState } from "react";
import type { FileStatus } from "@wowsm/git";

export interface FileTreeProps {
  root: string;
  paths: readonly string[];
  status: readonly FileStatus[];
  onSelect: (path: string) => void;
  selected: string | null;
}

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  isFile: boolean;
}

function buildTree(root: string, paths: readonly string[]): TreeNode {
  const tree: TreeNode = { name: root, path: root, children: new Map(), isFile: false };
  const prefix = root.endsWith("/") ? root : `${root}/`;

  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    // `.git` is noise for exploration; git state is shown via decorations.
    const relative = path.slice(prefix.length);
    if (relative === "" || relative.startsWith(".git/") || relative === ".git") continue;

    const segments = relative.split("/");
    let node = tree;
    segments.forEach((segment, index) => {
      const isLast = index === segments.length - 1;
      let child = node.children.get(segment);
      if (!child) {
        child = {
          name: segment,
          path: `${node.path}/${segment}`,
          children: new Map(),
          isFile: isLast,
        };
        node.children.set(segment, child);
      } else if (!isLast) {
        child.isFile = false;
      }
      node = child;
    });
  }
  return tree;
}

const STATE_MARK: Record<FileStatus["state"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "?",
  conflicted: "!",
};

function Decoration({ status }: { status: FileStatus }): React.JSX.Element {
  const binary = status.added === -1;
  return (
    <span className="decoration">
      <span className={`state state-${status.state}`}>{STATE_MARK[status.state]}</span>
      {binary ? (
        <span className="dim">bin</span>
      ) : (
        <>
          {status.added > 0 && <span className="added">+{status.added}</span>}
          {status.removed > 0 && <span className="removed">−{status.removed}</span>}
        </>
      )}
    </span>
  );
}

interface RowProps {
  node: TreeNode;
  depth: number;
  statusByPath: Map<string, FileStatus>;
  /** A directory is decorated when anything beneath it changed. */
  dirtyDirs: Set<string>;
  onSelect: (path: string) => void;
  selected: string | null;
}

function Row({ node, depth, statusByPath, dirtyDirs, onSelect, selected }: RowProps): React.JSX.Element {
  const [open, setOpen] = useState(depth < 2);
  const status = statusByPath.get(node.path);
  const children = useMemo(
    () =>
      [...node.children.values()].sort((a, b) => {
        if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
        return a.name.localeCompare(b.name);
      }),
    [node.children],
  );

  const isDirty = status !== undefined || dirtyDirs.has(node.path);

  return (
    <>
      <div
        className={`row${selected === node.path ? " selected" : ""}${isDirty ? " dirty" : ""}`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => (node.isFile ? onSelect(node.path) : setOpen((v) => !v))}
      >
        <span className="glyph">{node.isFile ? "" : open ? "▾" : "▸"}</span>
        <span className="name">{node.name}</span>
        {status && <Decoration status={status} />}
      </div>
      {!node.isFile &&
        open &&
        children.map((child) => (
          <Row
            key={child.path}
            node={child}
            depth={depth + 1}
            statusByPath={statusByPath}
            dirtyDirs={dirtyDirs}
            onSelect={onSelect}
            selected={selected}
          />
        ))}
    </>
  );
}

export function FileTree({ root, paths, status, onSelect, selected }: FileTreeProps): React.JSX.Element {
  const tree = useMemo(() => buildTree(root, paths), [root, paths]);

  const statusByPath = useMemo(() => {
    const map = new Map<string, FileStatus>();
    for (const entry of status) {
      // Status paths are relative to the repo root.
      map.set(entry.path.startsWith("/") ? entry.path : `${root}/${entry.path}`, entry);
    }
    return map;
  }, [status, root]);

  const dirtyDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const path of statusByPath.keys()) {
      let current = path;
      for (;;) {
        const slash = current.lastIndexOf("/");
        if (slash <= 0) break;
        current = current.slice(0, slash);
        if (current.length < root.length) break;
        dirs.add(current);
      }
    }
    return dirs;
  }, [statusByPath, root]);

  const empty = tree.children.size === 0;

  return (
    <div className="file-tree">
      <div className="pane-header">
        <span>Files</span>
        {status.length > 0 && <span className="badge">{status.length} changed</span>}
      </div>
      <div className="tree-body">
        {empty ? (
          <p className="empty">
            No files yet. Clone a repository from the terminal to populate the workspace.
          </p>
        ) : (
          [...tree.children.values()]
            .sort((a, b) => {
              if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
              return a.name.localeCompare(b.name);
            })
            .map((child) => (
              <Row
                key={child.path}
                node={child}
                depth={0}
                statusByPath={statusByPath}
                dirtyDirs={dirtyDirs}
                onSelect={onSelect}
                selected={selected}
              />
            ))
        )}
      </div>
    </div>
  );
}
