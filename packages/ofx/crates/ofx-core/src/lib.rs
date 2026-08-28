//! ofx — an open coding agent.
//!
//! This crate is the whole agent and nothing else: the turn loop, the provider
//! adapters, the tool definitions and the prompt. It has no I/O of its own.
//! A host supplies two traits — [`Host`] for the workspace and [`HttpClient`]
//! for the network — which is what lets the same core run as a native CLI and
//! inside a browser tab.
//!
//! Everything is `?Send`, because wasm futures are not `Send` and requiring it
//! would make the browser target impossible.

pub mod agent;
pub mod error;
pub mod event;
pub mod host;
pub mod http;
pub mod message;
pub mod prompt;
pub mod provider;
pub mod sse;
pub mod tool;

pub use agent::{Agent, AgentConfig};
pub use error::{OfxError, Result};
pub use event::{AgentEvent, EventSink, NullSink, Usage};
pub use host::{ExecOutput, Host};
pub use http::{ByteStream, HttpClient, HttpRequest, HttpResponse};
pub use message::{Content, Message, Role, StopReason};
pub use prompt::system_prompt;
pub use provider::{Delta, ModelConfig, Provider, ProviderId};
pub use sse::{SseEvent, SseParser};
pub use tool::{ToolSchema, builtin_tools};
