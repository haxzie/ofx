import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileStatus } from "@wowsm/git";
import { FileTree } from "./components/FileTree.js";
import { GitHubIcon, TuneIcon } from "./components/Icons.js";
import { clearGitToken, getSession, signInWithGitHub, signOut, type SessionUser } from "./auth.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { SidePanel } from "./components/SidePanel.js";
import { TerminalPane } from "./components/Terminal.js";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from "./settings.js";
import type { Workspace } from "./workspace.js";

const PREVIEW_LIMIT = 200_000;
const REPO_URL = "https://github.com/haxzie/ofx";

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [paths, setPaths] = useState<readonly string[]>([]);
  const [status, setStatus] = useState<readonly FileStatus[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  // Settings are open on load: without a key the agent cannot do anything.
  const [panel, setPanel] = useState<"settings" | "file" | null>("settings");
  const [user, setUser] = useState<SessionUser | null>(null);

  // The workspace reads settings on every command, so it needs the latest
  // value without being rebuilt.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    void getSession().then(setUser);
  }, []);

  const handleSignOut = useCallback(async () => {
    await signOut();
    clearGitToken();
    setUser(null);
  }, []);

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
          setPreview(`(${stat.size.toLocaleString()} bytes — too large to show)`);
          setPanel("file");
          return;
        }
        setPreview(await workspace.fs.readFile(path));
        setPanel("file");
      } catch (error) {
        setPreview(`(cannot read: ${error instanceof Error ? error.message : String(error)})`);
        setPanel("file");
      }
    },
    [workspace],
  );

  const handleSave = useCallback(
    async (next: Settings) => {
      setSettings(next);
      settingsRef.current = next;
      await saveSettings(next);
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
        <button
          type="button"
          className={`icon-button${panel === "settings" ? " active" : ""}`}
          onClick={() => setPanel((p) => (p === "settings" ? null : "settings"))}
          aria-label="Settings"
          aria-pressed={panel === "settings"}
          title="Settings"
        >
          <TuneIcon />
        </button>
        <a
          className="icon-button"
          href={REPO_URL}
          target="_blank"
          rel="noreferrer noopener"
          aria-label="Source on GitHub"
          title="Source on GitHub"
        >
          <GitHubIcon />
        </a>
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
        {panel === "settings" && (
          <SidePanel title="Settings" onClose={() => setPanel(null)}>
            <SettingsPanel
              settings={settings}
              user={user}
              onSave={(next) => void handleSave(next)}
              onReset={() => void handleReset()}
              onSignIn={() => void signInWithGitHub()}
              onSignOut={() => void handleSignOut()}
            />
          </SidePanel>
        )}
        {panel === "file" && selected && (
          <SidePanel
            title={selected.split("/").pop() ?? selected}
            subtitle={selected}
            onClose={() => setPanel(null)}
          >
            <pre className="file-view">{preview}</pre>
          </SidePanel>
        )}
      </div>

    </div>
  );
}
