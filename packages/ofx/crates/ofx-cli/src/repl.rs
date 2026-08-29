use crate::render::Renderer;
use anyhow::Result;
use ofx_core::agent::{Agent, AgentConfig};
use ofx_core::host::Host;
use ofx_core::http::HttpClient;
use ofx_core::message::Message;
use ofx_core::provider::{ModelConfig, ProviderId};
use rustyline::DefaultEditor;
use rustyline::error::ReadlineError;
use std::path::PathBuf;
use tokio::runtime::Runtime;

const HELP: &str = "
  /help                 show this
  /clear                forget the conversation
  /model <id>           switch model
  /provider <name>      switch provider (anthropic, openai, gemini, moonshot, glm, custom)
  /tokens               usage so far this session
  /exit                 leave (or Ctrl-D)

Anything else is sent to the agent. Ctrl-C cancels a running turn.";

/// `~/.ofx/history`, so recall survives restarts.
fn history_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let dir = PathBuf::from(home).join(".ofx");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("history"))
}

/// An interactive session.
///
/// The agent is rebuilt per turn from `model` and `messages`, which is what
/// makes `/model` and `/provider` switchable mid-conversation without losing
/// the transcript.
pub struct Repl<'a> {
    host: &'a dyn Host,
    client: &'a dyn HttpClient,
    model: ModelConfig,
    config: AgentConfig,
    messages: Vec<Message>,
    runtime: Runtime,
    renderer: Renderer,
    input_tokens: u32,
    output_tokens: u32,
}

impl<'a> Repl<'a> {
    pub fn new(
        host: &'a dyn Host,
        client: &'a dyn HttpClient,
        model: ModelConfig,
        config: AgentConfig,
        runtime: Runtime,
        renderer: Renderer,
    ) -> Self {
        Self {
            host,
            client,
            model,
            config,
            messages: Vec::new(),
            runtime,
            renderer,
            input_tokens: 0,
            output_tokens: 0,
        }
    }

    /// Run a single prompt and return, for the non-interactive `ofx "..."` form.
    pub fn run_once(&mut self, prompt: &str) -> Result<()> {
        self.turn(prompt);
        Ok(())
    }

    pub fn run(&mut self) -> Result<()> {
        let mut editor = DefaultEditor::new()?;
        let history = history_path();
        if let Some(path) = &history {
            let _ = editor.load_history(path);
        }

        println!(
            "ofx · {} · {}\nin {}\n/help for commands, Ctrl-D to exit\n",
            self.model.provider.as_str(),
            self.model.model,
            self.host.cwd()
        );

        loop {
            match editor.readline("ofx › ") {
                Ok(line) => {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    let _ = editor.add_history_entry(line);
                    if self.dispatch(line) {
                        break;
                    }
                    println!();
                }
                // Ctrl-C at the prompt abandons the line, as a shell does.
                Err(ReadlineError::Interrupted) => continue,
                Err(ReadlineError::Eof) => break,
                Err(err) => {
                    eprintln!("input error: {err}");
                    break;
                }
            }
        }

        if let Some(path) = &history {
            let _ = editor.save_history(path);
        }
        Ok(())
    }

    /// Returns true when the session should end.
    fn dispatch(&mut self, line: &str) -> bool {
        let (command, argument) = match line.split_once(char::is_whitespace) {
            Some((c, a)) => (c, a.trim()),
            None => (line, ""),
        };

        match command {
            "/exit" | "/quit" | "exit" | "quit" => return true,

            "/help" => println!("{HELP}"),

            "/clear" => {
                self.messages.clear();
                println!("conversation cleared");
            }

            "/tokens" => println!(
                "{} in / {} out this session",
                self.input_tokens, self.output_tokens
            ),

            "/model" => {
                if argument.is_empty() {
                    println!("{}", self.model.model);
                } else {
                    self.model.model = argument.to_string();
                    println!("model: {}", self.model.model);
                }
            }

            "/provider" => match ProviderId::parse(argument) {
                Some(provider) => {
                    // A key for one provider is no good for another, so ask for
                    // the new one rather than failing on the next request.
                    match std::env::var(provider.key_env_var()) {
                        Ok(key) if !key.is_empty() => {
                            self.model = ModelConfig::new(provider, key);
                            println!("provider: {} · {}", provider.as_str(), self.model.model);
                        }
                        _ => println!(
                            "no key for {}: set {}",
                            provider.as_str(),
                            provider.key_env_var()
                        ),
                    }
                }
                None => println!(
                    "unknown provider. one of: {}",
                    ProviderId::ALL
                        .iter()
                        .map(|p| p.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            },

            other if other.starts_with('/') => {
                println!("unknown command {other}. /help for the list.")
            }

            _ => self.turn(line),
        }
        false
    }

    fn turn(&mut self, prompt: &str) {
        let mut agent = Agent::new(
            self.host,
            self.client,
            self.model.clone(),
            self.config.clone(),
        );
        agent.set_messages(std::mem::take(&mut self.messages));
        // Snapshot so a cancelled turn can be rolled back to a well-formed
        // transcript rather than leaving a user message with no reply.
        let snapshot = agent.messages().to_vec();

        // The first wait of a turn is the request itself, before any event
        // arrives, so the animation starts here rather than in the sink.
        self.renderer.begin_turn();

        let outcome = self.runtime.block_on(async {
            tokio::select! {
                result = agent.run_turn(prompt, &mut self.renderer) => Some(result),
                // Dropping the turn future cancels the in-flight request.
                _ = tokio::signal::ctrl_c() => None,
            }
        });

        self.renderer.end_turn();

        match outcome {
            Some(Ok(_)) => {
                self.messages = agent.messages().to_vec();
                let usage = self.renderer.take_usage();
                self.input_tokens += usage.0;
                self.output_tokens += usage.1;
            }
            Some(Err(err)) => {
                self.messages = agent.messages().to_vec();
                eprintln!("error: {err}");
            }
            None => {
                self.messages = snapshot;
                println!("\n^C cancelled");
            }
        }
    }
}
