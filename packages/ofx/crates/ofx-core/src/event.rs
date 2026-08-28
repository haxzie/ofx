use crate::message::StopReason;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

/// What the embedder observes while a turn runs.
///
/// The CLI renders these to a terminal; the browser host forwards them to
/// JavaScript, which writes them into xterm and refreshes the file tree.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentEvent {
    /// A fragment of assistant prose.
    TextDelta { text: String },
    /// A tool is about to run, with its fully assembled arguments.
    ToolStart {
        id: String,
        name: String,
        input: Value,
    },
    ToolEnd {
        id: String,
        name: String,
        output: String,
        is_error: bool,
    },
    /// One request/response round finished; the loop may still continue.
    StepComplete { usage: Usage },
    /// The turn is over.
    TurnComplete { stop: StopReason, usage: Usage },
}

/// Receives events as the turn progresses.
pub trait EventSink {
    fn emit(&mut self, event: AgentEvent);
}

/// Discards everything — useful in tests and for non-interactive runs.
pub struct NullSink;

impl EventSink for NullSink {
    fn emit(&mut self, _event: AgentEvent) {}
}

impl<F: FnMut(AgentEvent)> EventSink for F {
    fn emit(&mut self, event: AgentEvent) {
        self(event)
    }
}
