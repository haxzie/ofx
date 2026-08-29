import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import type { Workspace } from "../workspace.js";
import { createOfxAgent, type OfxAgentHandle, type OfxEvent } from "../ofx.js";
import type { Settings } from "../settings.js";

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
} as const;

const BANNER = [
  `${ANSI.cyan}ofx${ANSI.reset} ${ANSI.dim}— an open coding agent, running entirely in your browser${ANSI.reset}`,
  "",
  `  ${ANSI.dim}Start a session:${ANSI.reset}`,
  `  ${ANSI.green}ofx${ANSI.reset}${ANSI.dim}                                  interactive${ANSI.reset}`,
  `  ${ANSI.green}ofx${ANSI.reset} ${ANSI.dim}"summarise this repo"            one-shot${ANSI.reset}`,
  "",
  `  ${ANSI.dim}It works on a real repository — clone one first:${ANSI.reset}`,
  `  ${ANSI.green}git clone https://github.com/octocat/Hello-World .${ANSI.reset}`,
  "",
];

export interface TerminalPaneProps {
  workspace: Workspace | null;
  settings: Settings;
  /** Called after every command so the file tree can refresh its decorations. */
  onAfterCommand: () => void;
}

export function TerminalPane({
  workspace,
  settings,
  onAfterCommand,
}: TerminalPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  /** Toggled while a turn is waiting on the model, not on DOM state. */
  const indicatorRef = useRef<HTMLDivElement>(null);
  /** Set by the mount effect so the prompt can be refreshed from outside it. */
  const redrawRef = useRef<(() => void) | null>(null);
  // The command loop closes over these, so they must not be React state.
  const workspaceRef = useRef(workspace);
  const afterRef = useRef(onAfterCommand);
  const settingsRef = useRef(settings);
  /** Cached agent, rebuilt when the model settings change. */
  const agentRef = useRef<{ key: string; handle: OfxAgentHandle } | null>(null);
  workspaceRef.current = workspace;
  afterRef.current = onAfterCommand;
  settingsRef.current = settings;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new XTerm({
      convertEol: true,
      cursorBlink: true,
      fontFamily: '"SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      theme: {
        background: "#12141a",
        foreground: "#d6dae4",
        cursor: "#7aa2f7",
        selectionBackground: "#2a3050",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(container);

    for (const line of BANNER) term.writeln(line);

    // "shell" runs just-bash; "agent" sends every line to ofx.
    let mode: "shell" | "agent" = "shell";
    let buffer = "";
    let cursor = 0;
    let historyIndex = -1;
    let draft = "";
    let busy = false;
    let abort: AbortController | null = null;

    const prompt = (): string => {
      if (mode === "agent") return `${ANSI.cyan}ofx${ANSI.reset} ${ANSI.green}›${ANSI.reset} `;
      const ws = workspaceRef.current;
      const cwd = ws ? ws.shell.cwd : "…";
      const short = cwd === ws?.root ? "~" : cwd.replace(`${ws?.root ?? ""}/`, "~/");
      return `${ANSI.blue}${short}${ANSI.reset} ${ANSI.green}$${ANSI.reset} `;
    };

    const writePrompt = (): void => {
      term.write(`\r\n${prompt()}`);
      renderedRow = 0;
    };

    /** Rows the input block occupied below its first line, at last redraw. */
    let renderedRow = 0;

    const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, "");

    /**
     * Redraw the input line.
     *
     * Input longer than the terminal is wide wraps onto several rows, so a
     * single erase-to-end-of-line would leave the earlier rows behind. Move
     * back to the first row of the block, clear everything below it, then
     * reposition the cursor by absolute offset.
     */
    const redraw = (): void => {
      const cols = Math.max(term.cols, 1);
      const promptWidth = stripAnsi(prompt()).length;

      if (renderedRow > 0) term.write(`\x1b[${renderedRow}A`);
      term.write(`\r\x1b[J${prompt()}${buffer}`);

      const endRow = Math.floor((promptWidth + buffer.length) / cols);
      const cursorOffset = promptWidth + cursor;
      const cursorRow = Math.floor(cursorOffset / cols);
      const cursorCol = cursorOffset % cols;

      if (endRow > cursorRow) term.write(`\x1b[${endRow - cursorRow}A`);
      term.write("\r");
      if (cursorCol > 0) term.write(`\x1b[${cursorCol}C`);
      renderedRow = cursorRow;
    };

    /** One-line summary of a tool call, so the log stays scannable. */
    const summarize = (name: string, input: Record<string, unknown>): string => {
      const key = name === "bash" ? "command" : name.startsWith("g") ? "pattern" : "path";
      const detail = String(input[key] ?? "").split("\n")[0] ?? "";
      return detail ? `${name} ${detail.slice(0, 90)}` : name;
    };

    // Lives outside the terminal grid — an xterm cell can't host a CSS
    // animation — so it floats over the pane while a turn is in flight.
    const showThinking = (): void => indicatorRef.current?.classList.add("visible");
    const hideThinking = (): void => indicatorRef.current?.classList.remove("visible");

    const runAgent = async (prompt: string, signal?: AbortSignal): Promise<void> => {
      const ws = workspaceRef.current;
      if (!ws) return;
      const s = settingsRef.current;

      if (!s.apiKey) {
        term.write(`${ANSI.red}No API key. Open Settings and add one.${ANSI.reset}\r\n`);
        return;
      }

      // Rebuild only when the model configuration actually changed, so the
      // conversation survives across turns.
      const key = `${s.provider}|${s.baseUrl}|${s.model}|${s.apiKey}`;
      if (agentRef.current?.key !== key) {
        const handle = await createOfxAgent(s, ws);
        if (!handle) {
          term.write(`${ANSI.red}Could not start ofx.${ANSI.reset}\r\n`);
          return;
        }
        agentRef.current = { key, handle };
      }

      let midLine = false;
      showThinking();
      try {
        await agentRef.current.handle.runTurn(prompt, (event: OfxEvent) => {
          switch (event.type) {
            case "textDelta":
              hideThinking();
              term.write(event.text.replace(/\n/g, "\r\n"));
              midLine = !event.text.endsWith("\n");
              break;
            case "toolStart":
              hideThinking();
              if (midLine) term.write("\r\n");
              term.write(`${ANSI.dim}· ${summarize(event.name, event.input)}${ANSI.reset}\r\n`);
              midLine = false;
              break;
            case "toolEnd":
              if (event.isError) {
                term.write(`${ANSI.red}  ! ${event.output.split("\n")[0]}${ANSI.reset}\r\n`);
              }
              // The tool has finished but the model still needs to react to
              // it, so the indicator comes back until the next event.
              showThinking();
              // The file tree should track the agent's edits as they land.
              afterRef.current();
              break;
            case "turnComplete":
              hideThinking();
              if (midLine) term.write("\r\n");
              term.write(
                `${ANSI.dim}${event.usage.inputTokens} in / ${event.usage.outputTokens} out${ANSI.reset}\r\n`,
              );
              break;
            default:
              break;
          }
        }, signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        term.write(
          signal?.aborted
            ? `\r\n${ANSI.yellow}^C cancelled${ANSI.reset}\r\n`
            : `\r\n${ANSI.red}${message}${ANSI.reset}\r\n`,
        );
      } finally {
        hideThinking();
        afterRef.current();
      }
    };

    const AGENT_HELP = [
      `  ${ANSI.green}/clear${ANSI.reset}   forget the conversation`,
      `  ${ANSI.green}/help${ANSI.reset}    show this`,
      `  ${ANSI.green}/exit${ANSI.reset}    back to the shell (or Ctrl-D)`,
      "",
      `  ${ANSI.dim}Anything else is sent to the agent. Ctrl-C cancels a running turn.${ANSI.reset}`,
    ];

    const enterAgentMode = (): void => {
      mode = "agent";
      const s = settingsRef.current;
      term.write(
        `${ANSI.cyan}ofx${ANSI.reset} ${ANSI.dim}· ${s.provider} · ${s.model || "no model set"}${ANSI.reset}\r\n`,
      );
      term.write(`${ANSI.dim}/help for commands, /exit to leave${ANSI.reset}\r\n`);
    };

    const leaveAgentMode = (): void => {
      mode = "shell";
      term.write(`${ANSI.dim}left ofx${ANSI.reset}\r\n`);
    };

    /** Agent-mode line handling. Returns true when the line was a command. */
    const agentCommand = (line: string): boolean => {
      switch (line) {
        case "/exit":
        case "/quit":
        case "exit":
        case "quit":
          leaveAgentMode();
          return true;
        case "/help":
          for (const row of AGENT_HELP) term.write(`${row}\r\n`);
          return true;
        case "/clear":
          agentRef.current?.handle.clear();
          term.write(`${ANSI.dim}conversation cleared${ANSI.reset}\r\n`);
          return true;
        default:
          return false;
      }
    };

    const runLine = async (line: string): Promise<void> => {
      const ws = workspaceRef.current;
      if (!ws) {
        term.writeln(`\r\n${ANSI.red}workspace is still loading${ANSI.reset}`);
        return;
      }

      const trimmed = line.trim();

      // In agent mode every line is a prompt, so the shell is bypassed.
      if (mode === "agent") {
        if (agentCommand(trimmed)) return;
        abort = new AbortController();
        await runAgent(trimmed, abort.signal);
        abort = null;
        return;
      }

      // `ofx` is handled here rather than as a just-bash command so its output
      // can stream token by token; a shell command only returns once finished.
      if (trimmed === "ofx") {
        enterAgentMode();
        return;
      }
      const agentPrompt = trimmed.match(/^ofx\s+([\s\S]+)$/)?.[1];
      if (agentPrompt) {
        abort = new AbortController();
        await runAgent(agentPrompt.replace(/^["']|["']$/g, ""), abort.signal);
        abort = null;
        return;
      }
      abort = new AbortController();
      try {
        const result = await ws.shell.run(line, { signal: abort.signal });
        if (result.stdout) term.write(result.stdout.replace(/\n/g, "\r\n"));
        if (result.stderr) {
          // git reports normal progress on stderr, so only colour it as an
          // error when the command actually failed.
          const colour = result.exitCode === 0 ? ANSI.dim : ANSI.red;
          term.write(`${colour}${result.stderr.replace(/\n/g, "\r\n")}${ANSI.reset}`);
        }
        if (result.exitCode !== 0 && !result.stderr) {
          term.write(`${ANSI.yellow}exit ${result.exitCode}${ANSI.reset}\r\n`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        term.write(`${ANSI.red}${message}${ANSI.reset}\r\n`);
      } finally {
        abort = null;
        afterRef.current();
      }
    };

    const submit = async (): Promise<void> => {
      const line = buffer;
      buffer = "";
      cursor = 0;
      historyIndex = -1;
      term.write("\r\n");
      renderedRow = 0;
      if (line.trim() !== "") {
        busy = true;
        await runLine(line);
        busy = false;
      }
      term.write(prompt());
    };

    const disposable = term.onData((data) => {
      if (busy) {
        // Ctrl-C cancels the running command; other input is ignored.
        if (data === "\x03") abort?.abort();
        return;
      }

      switch (data) {
        case "\r":
          void submit();
          return;
        case "\x7f": // Backspace
          if (cursor > 0) {
            buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
            cursor -= 1;
            redraw();
          }
          return;
        case "\x03": // Ctrl-C
          term.write("^C");
          buffer = "";
          cursor = 0;
          historyIndex = -1;
          writePrompt();
          return;
        case "\x04": // Ctrl-D — leaves the agent when the line is empty
          if (mode === "agent" && buffer === "") {
            term.write("\r\n");
            leaveAgentMode();
            term.write(prompt());
            renderedRow = 0;
          }
          return;
        case "\x0c": // Ctrl-L
          term.clear();
          renderedRow = 0;
          redraw();
          return;
        case "\x01": // Ctrl-A
          cursor = 0;
          redraw();
          return;
        case "\x05": // Ctrl-E
          cursor = buffer.length;
          redraw();
          return;
        case "\x15": // Ctrl-U
          buffer = buffer.slice(cursor);
          cursor = 0;
          redraw();
          return;
        case "\x1b[A": { // Up — walk back through history
          const history = workspaceRef.current?.shell.history ?? [];
          if (history.length === 0) return;
          if (historyIndex === -1) draft = buffer;
          historyIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
          buffer = history[historyIndex] ?? "";
          cursor = buffer.length;
          redraw();
          return;
        }
        case "\x1b[B": { // Down
          const history = workspaceRef.current?.shell.history ?? [];
          if (historyIndex === -1) return;
          historyIndex += 1;
          if (historyIndex >= history.length) {
            historyIndex = -1;
            buffer = draft;
          } else {
            buffer = history[historyIndex] ?? "";
          }
          cursor = buffer.length;
          redraw();
          return;
        }
        case "\x1b[D": // Left
          if (cursor > 0) {
            cursor -= 1;
            redraw();
          }
          return;
        case "\x1b[C": // Right
          if (cursor < buffer.length) {
            cursor += 1;
            redraw();
          }
          return;
        default:
          break;
      }

      // Ignore remaining control sequences; insert printable text.
      if (data < " " && data !== "\t") return;
      if (data.startsWith("\x1b")) return;
      buffer = buffer.slice(0, cursor) + data + buffer.slice(cursor);
      cursor += data.length;
      redraw();
    });

    // Remote sideband progress (clone/fetch/push) streams straight through.
    const onProgress = (event: Event): void => {
      const detail = (event as CustomEvent<string>).detail;
      term.write(`${ANSI.dim}${detail.replace(/\n/g, "\r\n")}${ANSI.reset}`);
    };
    window.addEventListener("ofx:progress", onProgress);

    redrawRef.current = redraw;
    renderedRow = 0;
    term.write(prompt());
    term.focus();

    return () => {
      redrawRef.current = null;
      window.removeEventListener("ofx:progress", onProgress);
      disposable.dispose();
      observer.disconnect();
      term.dispose();
    };
  }, []);

  // The first prompt renders before the workspace exists; refresh it once the
  // real working directory is known.
  useEffect(() => {
    if (workspace) redrawRef.current?.();
  }, [workspace]);

  return (
    <div className="terminal-pane-wrap">
      <div className="terminal-pane" ref={containerRef} />
      <div className="thinking-indicator" ref={indicatorRef}>
        <span className="thinking-dot" />
        Thinking…
      </div>
    </div>
  );
}
