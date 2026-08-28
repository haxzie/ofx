use ofx_core::event::{AgentEvent, EventSink, Usage};
use std::io::{IsTerminal, Write};

struct Palette {
    dim: &'static str,
    red: &'static str,
    reset: &'static str,
}

const COLOUR: Palette = Palette {
    dim: "\x1b[2m",
    red: "\x1b[31m",
    reset: "\x1b[0m",
};

const PLAIN: Palette = Palette {
    dim: "",
    red: "",
    reset: "",
};

/// Renders agent events to the terminal.
///
/// Shell-like rather than a TUI: prose streams straight to stdout, tool calls
/// get one dim line each, and nothing repaints.
pub struct Renderer {
    palette: &'static Palette,
    verbose: bool,
    /// Tracks whether the cursor sits mid-line, so separators land correctly.
    mid_line: bool,
    /// Usage from the most recent completed turn, drained by the REPL.
    last_usage: Usage,
}

impl Renderer {
    pub fn new(verbose: bool) -> Self {
        Self {
            palette: if std::io::stdout().is_terminal() {
                &COLOUR
            } else {
                &PLAIN
            },
            verbose,
            mid_line: false,
            last_usage: Usage::default(),
        }
    }

    /// Take the last turn's usage, resetting the accumulator.
    pub fn take_usage(&mut self) -> (u32, u32) {
        let usage = std::mem::take(&mut self.last_usage);
        (usage.input_tokens, usage.output_tokens)
    }

    fn newline_if_needed(&mut self) {
        if self.mid_line {
            println!();
            self.mid_line = false;
        }
    }

    /// One-line summary of a tool call, so the log stays readable.
    fn summarize(name: &str, input: &serde_json::Value) -> String {
        let detail = match name {
            "bash" => input["command"].as_str().unwrap_or("").to_string(),
            "grep_files" => input["pattern"].as_str().unwrap_or("").to_string(),
            "glob_files" => input["pattern"].as_str().unwrap_or("").to_string(),
            _ => input["path"].as_str().unwrap_or("").to_string(),
        };
        let detail: String = detail
            .lines()
            .next()
            .unwrap_or("")
            .chars()
            .take(90)
            .collect();
        if detail.is_empty() {
            name.to_string()
        } else {
            format!("{name} {detail}")
        }
    }
}

impl EventSink for Renderer {
    fn emit(&mut self, event: AgentEvent) {
        let p = self.palette;
        match event {
            AgentEvent::TextDelta { text } => {
                print!("{text}");
                let _ = std::io::stdout().flush();
                self.mid_line = !text.ends_with('\n');
            }

            AgentEvent::ToolStart { name, input, .. } => {
                self.newline_if_needed();
                println!("{}· {}{}", p.dim, Self::summarize(&name, &input), p.reset);
            }

            AgentEvent::ToolEnd {
                output, is_error, ..
            } => {
                if is_error {
                    self.newline_if_needed();
                    println!(
                        "{}  ! {}{}",
                        p.red,
                        output.lines().next().unwrap_or(""),
                        p.reset
                    );
                } else if self.verbose {
                    for line in output.lines().take(20) {
                        println!("{}  {line}{}", p.dim, p.reset);
                    }
                }
            }

            AgentEvent::StepComplete { .. } => {}

            AgentEvent::TurnComplete { usage, .. } => {
                self.last_usage = usage;
                self.newline_if_needed();
                if self.verbose {
                    let Usage {
                        input_tokens,
                        output_tokens,
                    } = usage;
                    println!(
                        "{}{input_tokens} in / {output_tokens} out{}",
                        p.dim, p.reset
                    );
                }
            }
        }
    }
}
