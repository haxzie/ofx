use crate::error::Result;
use crate::http::HttpRequest;
use crate::message::{Message, StopReason};
use crate::sse::SseEvent;
use crate::tool::ToolSchema;
use serde::{Deserialize, Serialize};

pub mod anthropic;
pub mod gemini;
pub mod openai;

/// A normalized fragment of a streamed assistant turn.
///
/// Providers disagree on nearly everything here — Anthropic streams tool
/// arguments as JSON fragments keyed by content-block index, OpenAI keys them
/// by tool-call index, Gemini sends each call whole — so each adapter maps its
/// wire format onto this.
#[derive(Debug, Clone, PartialEq)]
pub enum Delta {
    Text(String),
    ToolCallStart {
        index: usize,
        id: String,
        name: String,
    },
    /// A fragment of the tool call's JSON arguments, to be concatenated.
    ToolCallArgs {
        index: usize,
        fragment: String,
    },
    Stop(StopReason),
    Usage {
        input_tokens: u32,
        output_tokens: u32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderId {
    Anthropic,
    Openai,
    Gemini,
    Moonshot,
    Glm,
    /// Any other endpoint speaking OpenAI Chat Completions.
    OpenaiCompatible,
}

impl ProviderId {
    pub fn parse(value: &str) -> Option<Self> {
        match value
            .to_ascii_lowercase()
            .replace(['-', '_', ' '], "")
            .as_str()
        {
            "anthropic" | "claude" => Some(Self::Anthropic),
            "openai" => Some(Self::Openai),
            "gemini" | "google" => Some(Self::Gemini),
            "moonshot" | "kimi" => Some(Self::Moonshot),
            "glm" | "zhipu" | "bigmodel" => Some(Self::Glm),
            "openaicompatible" | "compatible" | "custom" => Some(Self::OpenaiCompatible),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::Openai => "openai",
            Self::Gemini => "gemini",
            Self::Moonshot => "moonshot",
            Self::Glm => "glm",
            Self::OpenaiCompatible => "openai-compatible",
        }
    }

    pub fn default_base_url(self) -> &'static str {
        match self {
            Self::Anthropic => "https://api.anthropic.com",
            Self::Openai => "https://api.openai.com/v1",
            Self::Gemini => "https://generativelanguage.googleapis.com",
            Self::Moonshot => "https://api.moonshot.ai/v1",
            Self::Glm => "https://open.bigmodel.cn/api/paas/v4",
            Self::OpenaiCompatible => "",
        }
    }

    pub fn default_model(self) -> &'static str {
        match self {
            Self::Anthropic => "claude-sonnet-5",
            Self::Openai => "gpt-5",
            Self::Gemini => "gemini-2.5-pro",
            Self::Moonshot => "kimi-k2",
            Self::Glm => "glm-4.6",
            Self::OpenaiCompatible => "",
        }
    }

    /// Environment variable conventionally holding this provider's key.
    pub fn key_env_var(self) -> &'static str {
        match self {
            Self::Anthropic => "ANTHROPIC_API_KEY",
            Self::Openai => "OPENAI_API_KEY",
            Self::Gemini => "GEMINI_API_KEY",
            Self::Moonshot => "MOONSHOT_API_KEY",
            Self::Glm => "GLM_API_KEY",
            Self::OpenaiCompatible => "OFX_API_KEY",
        }
    }

    pub fn build(self) -> Box<dyn Provider> {
        match self {
            Self::Anthropic => Box::new(anthropic::Anthropic),
            Self::Gemini => Box::new(gemini::Gemini),
            // Moonshot and GLM differ from OpenAI only by base URL and model
            // id, so they are configuration rather than code. They do keep the
            // older `max_tokens` field, which OpenAI itself has moved off.
            Self::Openai => Box::new(openai::OpenAi::new(true)),
            Self::Moonshot | Self::Glm | Self::OpenaiCompatible => {
                Box::new(openai::OpenAi::new(false))
            }
        }
    }

    pub const ALL: [Self; 6] = [
        Self::Anthropic,
        Self::Openai,
        Self::Gemini,
        Self::Moonshot,
        Self::Glm,
        Self::OpenaiCompatible,
    ];
}

#[derive(Debug, Clone)]
pub struct ModelConfig {
    pub provider: ProviderId,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub max_tokens: u32,
    /// Anthropic blocks browser-origin requests unless the caller opts in.
    pub browser_direct: bool,
}

impl ModelConfig {
    pub fn new(provider: ProviderId, api_key: impl Into<String>) -> Self {
        Self {
            provider,
            base_url: provider.default_base_url().to_string(),
            api_key: api_key.into(),
            model: provider.default_model().to_string(),
            max_tokens: 8192,
            browser_direct: false,
        }
    }

    /// Base URL with any trailing slash removed, so joins stay predictable.
    pub fn base(&self) -> &str {
        self.base_url.trim_end_matches('/')
    }
}

pub struct RequestContext<'a> {
    pub system: &'a str,
    pub messages: &'a [Message],
    pub tools: &'a [ToolSchema],
    pub config: &'a ModelConfig,
}

/// Translates between the core's normalized types and one provider's wire
/// format. Adapters are stateless; the agent accumulates streamed fragments.
pub trait Provider {
    fn name(&self) -> &'static str;

    fn build_request(&self, ctx: &RequestContext<'_>) -> Result<HttpRequest>;

    /// Map one server-sent event onto zero or more deltas.
    fn on_event(&self, event: &SseEvent) -> Result<Vec<Delta>>;
}
