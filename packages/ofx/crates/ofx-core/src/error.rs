use std::fmt;

/// Everything that can go wrong inside the agent core.
#[derive(Debug, thiserror::Error)]
pub enum OfxError {
    #[error("http error: {0}")]
    Http(String),

    #[error("provider {provider} returned status {status}: {body}")]
    ProviderStatus {
        provider: &'static str,
        status: u16,
        body: String,
    },

    #[error("failed to decode {provider} response: {detail}")]
    Decode {
        provider: &'static str,
        detail: String,
    },

    #[error("tool `{tool}` failed: {detail}")]
    Tool { tool: String, detail: String },

    #[error("configuration error: {0}")]
    Config(String),

    #[error("cancelled")]
    Cancelled,

    #[error("reached the {0}-step limit without finishing")]
    StepLimit(u32),
}

impl OfxError {
    pub fn decode(provider: &'static str, detail: impl fmt::Display) -> Self {
        Self::Decode {
            provider,
            detail: detail.to_string(),
        }
    }

    pub fn tool(tool: impl Into<String>, detail: impl fmt::Display) -> Self {
        Self::Tool {
            tool: tool.into(),
            detail: detail.to_string(),
        }
    }
}

pub type Result<T> = std::result::Result<T, OfxError>;
