import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileStatus } from "@wowsm/git";
import { FileTree } from "./components/FileTree.js";
import { SettingsDialog } from "./components/SettingsDialog.js";
import { TerminalPane } from "./components/Terminal.js";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from "./settings.js";
import type { Workspace } from "./workspace.js";

const PREVIEW_LIMIT = 200_000;

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [paths, setPaths] = useState<readonly string[]>([]);
  const [status, setStatus] = useState<readonly FileStatus[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  // The workspace reads settings on every command, so it needs the latest
  // value without being rebuilt.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await loadSettings();
        if (cancelled) return;
        setSettings(loaded);
        settingsRef.current = loaded;

        // Deferred so just-bash and just-git stay out of the initial chunk.
        const { bootWorkspace } = await import("./workspace.js");
        const ws = await bootWorkspace(() => settingsRef.current);
        if (cancelled) return;
        setWorkspace(ws);
      } catch (error) {
        if (!cancelled) setBootError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!workspace) return;
    setPaths(workspace.fs.getAllPaths());
    try {
      setStatus(await workspace.status());
    } catch {
      // Not a git repository yet — decorations simply stay empty.
      setStatus([]);
    }
  }, [workspace]);

  useEffect(() => {
    if (!workspace) return;
    void refresh();
    return workspace.fs.onChange(() => {
      void refresh();
    });
  }, [workspace, refresh]);

  const handleSelect = useCallback(
    async (path: string) => {
      if (!workspace) return;
      setSelected(path);
      try {
        const stat = await workspace.fs.stat(path);
        if (stat.size > PREVIEW_LIMIT) {
          setPreview(`(${stat.size.toLocaleString()} bytes — too large to preview)`);
          return;
        }
        setPreview(await workspace.fs.readFile(path));
      } catch (error) {
        setPreview(`(cannot read: ${error instanceof Error ? error.message : String(error)})`);
      }
    },
    [workspace],
  );

  const handleSave = useCallback(
    async (next: Settings) => {
      setSettings(next);
      settingsRef.current = next;
      await saveSettings(next);
      setShowSettings(false);
      // Identity lives in .git/config once a repo exists; keep them in sync.
      if (workspace) {
        await workspace.shell.run(`git config user.name ${JSON.stringify(next.gitName)}`);
        await workspace.shell.run(`git config user.email ${JSON.stringify(next.gitEmail)}`);
      }
    },
    [workspace],
  );

  const handleReset = useCallback(async () => {
    if (!workspace) return;
    if (!window.confirm("Delete every file in the workspace? This cannot be undone.")) return;
    await workspace.fs.reset();
    await workspace.fs.mkdir(workspace.root, { recursive: true });
    workspace.shell.reset();
    setSelected(null);
    setPreview(null);
    setShowSettings(false);
    await refresh();
  }, [workspace, refresh]);

  const summary = useMemo(() => {
    const added = status.reduce((sum, s) => sum + Math.max(0, s.added), 0);
    const removed = status.reduce((sum, s) => sum + Math.max(0, s.removed), 0);
    return { added, removed };
  }, [status]);

  return (
    <div className="app">
      <header className="app-header">
        <span className="logo">OFX</span>
        <span className="tagline">an open coding agent, running in your browser</span>
        <div className="spacer" />
        {status.length > 0 && (
          <span className="summary">
            <span className="added">+{summary.added}</span>
            <span className="removed">−{summary.removed}</span>
            <span className="dim">in {status.length} files</span>
          </span>
        )}
        <button type="button" onClick={() => setShowSettings(true)}>
          Settings
        </button>
      </header>

      {bootError && <div className="banner error">Failed to start workspace: {bootError}</div>}

      <div className="panes">
        <aside className="sidebar">
          <FileTree
            root={workspace?.root ?? "/workspace"}
            paths={paths}
            status={status}
            selected={selected}
            onSelect={(p) => void handleSelect(p)}
          />
        </aside>
        <main className="main">
          <TerminalPane
            workspace={workspace}
            settings={settings}
            onAfterCommand={() => void refresh()}
          />
        </main>
      </div>

      {preview !== null && selected && (
        <div className="overlay" onClick={() => setPreview(null)}>
          <div className="dialog preview" onClick={(e) => e.stopPropagation()}>
            <header>
              <h2>{selected}</h2>
              <button type="button" className="icon" onClick={() => setPreview(null)} aria-label="Close">
                ×
              </button>
            </header>
            <pre>{preview}</pre>
          </div>
        </div>
      )}

      {showSettings && (
        <SettingsDialog
          settings={settings}
          onSave={(next) => void handleSave(next)}
          onClose={() => setShowSettings(false)}
          onReset={() => void handleReset()}
        />
      )}
    </div>
  );
}
