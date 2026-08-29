use crate::error::{OfxError, Result};
use crate::event::{AgentEvent, EventSink, Usage};
use crate::host::Host;
use crate::http::{HttpClient, HttpRequest};
use crate::message::{Content, Message, StopReason};
use crate::prompt::system_prompt;
use crate::provider::{Delta, ModelConfig, Provider, RequestContext};
use crate::sse::SseParser;
use crate::tool::{ToolSchema, builtin_tools, dispatch};
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub struct AgentConfig {
    /// Cap on request/tool rounds in a single turn, so a confused model cannot
    /// loop forever.
    pub max_steps: u32,
    /// Project instructions appended to the system prompt.
    pub project_instructions: Option<String>,
    /// What the host's shell provides beyond git, named for the model.
    pub workspace_tools: Option<String>,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            max_steps: 40,
            project_instructions: None,
            workspace_tools: None,
        }
    }
}

/// A tool call being assembled from streamed fragments.
#[derive(Debug, Default)]
struct PartialCall {
    id: String,
    name: String,
    /// Concatenated JSON fragments; complete only once the stream ends.
    args: String,
}

#[derive(Debug, Default)]
struct Turn {
    text: String,
    /// Keyed by the provider's call index, which is why order is preserved.
    calls: BTreeMap<usize, PartialCall>,
    stop: Option<StopReason>,
    usage: Usage,
}

impl Turn {
    fn apply(&mut self, delta: Delta, sink: &mut dyn EventSink) {
        match delta {
            Delta::Text(text) => {
                self.text.push_str(&text);
                sink.emit(AgentEvent::TextDelta { text });
            }
            Delta::ToolCallStart { index, id, name } => {
                let call = self.calls.entry(index).or_default();
                call.id = id;
                call.name = name;
            }
            Delta::ToolCallArgs { index, fragment } => {
                self.calls
                    .entry(index)
                    .or_default()
                    .args
                    .push_str(&fragment);
            }
            Delta::Stop(stop) => self.stop = Some(stop),
            Delta::Usage {
                input_tokens,
                output_tokens,
            } => {
                // Providers report usage differently — Anthropic splits it
                // across two events, OpenAI sends one final total, Gemini sends
                // a running total — so keep the largest seen.
                self.usage.input_tokens = self.usage.input_tokens.max(input_tokens);
                self.usage.output_tokens = self.usage.output_tokens.max(output_tokens);
            }
        }
    }

    /// The assistant message this turn produced.
    fn into_message(
        self,
    ) -> (
        Message,
        Vec<(String, String, serde_json::Value)>,
        Usage,
        StopReason,
    ) {
        let mut content = Vec::new();
        if !self.text.is_empty() {
            content.push(Content::text(self.text));
        }

        let mut pending = Vec::new();
        for call in self.calls.into_values() {
            // A model that emits malformed JSON gets told so via a tool result
            // rather than killing the turn.
            let input = if call.args.trim().is_empty() {
                serde_json::json!({})
            } else {
                serde_json::from_str(&call.args).unwrap_or(serde_json::Value::Null)
            };
            content.push(Content::ToolUse {
                id: call.id.clone(),
                name: call.name.clone(),
                input: input.clone(),
            });
            pending.push((call.id, call.name, input));
        }

        let stop = self.stop.unwrap_or(if pending.is_empty() {
            StopReason::EndTurn
        } else {
            StopReason::ToolUse
        });

        (Message::assistant(content), pending, self.usage, stop)
    }
}

pub struct Agent<'a> {
    host: &'a dyn Host,
    http: &'a dyn HttpClient,
    provider: Box<dyn Provider>,
    model: ModelConfig,
    config: AgentConfig,
    tools: Vec<ToolSchema>,
    messages: Vec<Message>,
}

impl<'a> Agent<'a> {
    pub fn new(
        host: &'a dyn Host,
        http: &'a dyn HttpClient,
        model: ModelConfig,
        config: AgentConfig,
    ) -> Self {
        Self {
            provider: model.provider.build(),
            host,
            http,
            model,
            config,
            tools: builtin_tools(),
            messages: Vec::new(),
        }
    }

    pub fn messages(&self) -> &[Message] {
        &self.messages
    }

    /// Restore a prior conversation.
    pub fn set_messages(&mut self, messages: Vec<Message>) {
        self.messages = messages;
    }

    pub fn clear(&mut self) {
        self.messages.clear();
    }

    /// Run one user turn to completion, executing tools until the model stops
    /// asking for them.
    pub async fn run_turn(&mut self, input: &str, sink: &mut dyn EventSink) -> Result<StopReason> {
        self.messages.push(Message::user(input));

        let system = system_prompt(
            &self.host.cwd(),
            self.config.workspace_tools.as_deref(),
            self.config.project_instructions.as_deref(),
        );
        let mut total = Usage::default();

        for _ in 0..self.config.max_steps {
            let request = self.provider.build_request(&RequestContext {
                system: &system,
                messages: &self.messages,
                tools: &self.tools,
                config: &self.model,
            })?;

            let turn = self.stream(request, sink).await?;
            let (assistant, pending, usage, stop) = turn.into_message();

            total.input_tokens += usage.input_tokens;
            total.output_tokens += usage.output_tokens;
            sink.emit(AgentEvent::StepComplete { usage });

            self.messages.push(assistant);

            if pending.is_empty() {
                sink.emit(AgentEvent::TurnComplete { stop, usage: total });
                return Ok(stop);
            }

            let mut results = Vec::new();
            for (id, name, input) in pending {
                sink.emit(AgentEvent::ToolStart {
                    id: id.clone(),
                    name: name.clone(),
                    input: input.clone(),
                });

                let (output, is_error) = if input.is_null() {
                    (
                        format!("Arguments for `{name}` were not valid JSON. Call it again."),
                        true,
                    )
                } else {
                    match dispatch(self.host, &name, &input).await {
                        Ok(output) => (output, false),
                        // Tool failures are information for the model, not a
                        // reason to abandon the turn.
                        Err(OfxError::Cancelled) => return Err(OfxError::Cancelled),
                        Err(err) => (err.to_string(), true),
                    }
                };

                sink.emit(AgentEvent::ToolEnd {
                    id: id.clone(),
                    name,
                    output: output.clone(),
                    is_error,
                });
                results.push(Content::ToolResult {
                    tool_use_id: id,
                    content: output,
                    is_error,
                });
            }

            self.messages.push(Message::tool_results(results));
        }

        Err(OfxError::StepLimit(self.config.max_steps))
    }

    /// Issue one request and fold its event stream into a `Turn`.
    async fn stream(&self, request: HttpRequest, sink: &mut dyn EventSink) -> Result<Turn> {
        let mut response = self.http.send(request).await?;

        if !(200..300).contains(&response.status) {
            let mut body = Vec::new();
            while let Some(chunk) = response.body.next_chunk().await? {
                body.extend_from_slice(&chunk);
            }
            return Err(OfxError::ProviderStatus {
                provider: self.provider.name(),
                status: response.status,
                body: String::from_utf8_lossy(&body).chars().take(2000).collect(),
            });
        }

        let mut parser = SseParser::new();
        let mut turn = Turn::default();

        while let Some(chunk) = response.body.next_chunk().await? {
            for event in parser.feed(&chunk) {
                for delta in self.provider.on_event(&event)? {
                    turn.apply(delta, sink);
                }
            }
        }
        if let Some(event) = parser.finish() {
            for delta in self.provider.on_event(&event)? {
                turn.apply(delta, sink);
            }
        }

        Ok(turn)
    }
}
