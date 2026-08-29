//! ofx — an open coding agent.
//!
//! The same core drives this binary and the browser build; only the host layer
//! differs. Here that means real files, a real shell, and reqwest.

mod host;
mod http;
mod render;
mod repl;
mod spinner;

use anyhow::{Context, bail};
use clap::Parser;
use ofx_core::agent::AgentConfig;
use ofx_core::provider::{ModelConfig, ProviderId};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(
    name = "ofx",
    version,
    about = "An open coding agent",
    long_about = "Runs a coding agent against the current directory. Give it a prompt to run one \
                  turn, or run it bare for an interactive session."
)]
struct Cli {
    /// What to do. Omit for an interactive session.
    prompt: Vec<String>,

    /// Model provider: anthropic, openai, gemini, moonshot, glm, or custom.
    #[arg(short, long, env = "OFX_PROVIDER", default_value = "anthropic")]
    provider: String,

    /// Model id. Defaults to the provider's recommended model.
    #[arg(short, long, env = "OFX_MODEL")]
    model: Option<String>,

    /// Override the API base URL. Required for `custom`.
    #[arg(long, env = "OFX_BASE_URL")]
    base_url: Option<String>,

    /// API key. Falls back to the provider's usual environment variable.
    #[arg(long, env = "OFX_API_KEY", hide_env_values = true)]
    api_key: Option<String>,

    /// Directory to work in.
    #[arg(short = 'C', long, default_value = ".")]
    cwd: PathBuf,

    /// Maximum model/tool rounds in a single turn.
    #[arg(long, default_value_t = 40)]
    max_steps: u32,

    /// Maximum tokens per response.
    #[arg(long, default_value_t = 8192)]
    max_tokens: u32,

    /// Echo tool output and token usage.
    #[arg(short, long)]
    verbose: bool,
}

/// Project instructions, if the workspace has an AGENTS.md.
fn project_instructions(root: &std::path::Path) -> Option<String> {
    std::fs::read_to_string(root.join("AGENTS.md")).ok()
}

/// Name the optional tools that are actually on PATH.
///
/// Without this the model is told only that git works, and will decline to
/// reach for anything else — correctly, since it was never told otherwise.
fn workspace_tools() -> Option<String> {
    let mut found = vec!["a POSIX shell", "git"];
    for tool in ["gh", "rg", "jq", "curl"] {
        let present = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("command -v {tool}"))
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false);
        if present {
            found.push(match tool {
                "gh" => "gh (the GitHub CLI)",
                other => other,
            });
        }
    }
    Some(found.join(", "))
}

fn resolve_config(cli: &Cli) -> anyhow::Result<ModelConfig> {
    let provider = ProviderId::parse(&cli.provider).with_context(|| {
        format!(
            "unknown provider `{}` (expected one of: {})",
            cli.provider,
            ProviderId::ALL
                .iter()
                .map(|p| p.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
    })?;

    let api_key = cli
        .api_key
        .clone()
        .or_else(|| std::env::var(provider.key_env_var()).ok())
        .filter(|k| !k.is_empty())
        .with_context(|| {
            format!(
                "no API key: pass --api-key or set {}",
                provider.key_env_var()
            )
        })?;

    let mut config = ModelConfig::new(provider, api_key);
    config.max_tokens = cli.max_tokens;
    if let Some(model) = &cli.model {
        config.model = model.clone();
    }
    if let Some(base) = &cli.base_url {
        config.base_url = base.clone();
    }
    if config.base_url.is_empty() {
        bail!("provider `{}` needs --base-url", provider.as_str());
    }
    if config.model.is_empty() {
        bail!("provider `{}` needs --model", provider.as_str());
    }
    Ok(config)
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    let root = cli
        .cwd
        .canonicalize()
        .with_context(|| format!("no such directory: {}", cli.cwd.display()))?;
    let model = resolve_config(&cli)?;

    let host = host::NativeHost::new(root.clone());
    let client = http::ReqwestClient::new()?;
    let config = AgentConfig {
        max_steps: cli.max_steps,
        project_instructions: project_instructions(&root),
        workspace_tools: workspace_tools(),
    };

    // A current-thread runtime: the core's futures are deliberately `?Send` so
    // the same code compiles for wasm, so they cannot be spawned on a
    // work-stealing executor.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;

    let renderer = render::Renderer::new(cli.verbose);
    let mut session = repl::Repl::new(&host, &client, model, config, runtime, renderer);

    let prompt = cli.prompt.join(" ");
    if prompt.trim().is_empty() {
        session.run()
    } else {
        session.run_once(&prompt)
    }
}
