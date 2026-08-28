use super::{Delta, Provider, RequestContext};
use crate::error::{OfxError, Result};
use crate::http::HttpRequest;
use crate::message::{Content, Message, Role, StopReason};
use crate::sse::SseEvent;
use serde_json::{Value, json};

const NAME: &str = "anthropic";
const API_VERSION: &str = "2023-06-01";

/// Adapter for Anthropic's Messages API.
///
/// The only provider here with first-class content blocks, so the core's
/// message model maps onto it almost directly.
pub struct Anthropic;

fn content_to_json(content: &Content) -> Value {
    match content {
        Content::Text { text } => json!({ "type": "text", "text": text }),
        Content::ToolUse { id, name, input } => {
            json!({ "type": "tool_use", "id": id, "name": name, "input": input })
        }
        Content::ToolResult {
            tool_use_id,
            content,
            is_error,
        } => json!({
            "type": "tool_result",
            "tool_use_id": tool_use_id,
            "content": content,
            "is_error": is_error,
        }),
    }
}

impl Provider for Anthropic {
    fn name(&self) -> &'static str {
        NAME
    }

    fn build_request(&self, ctx: &RequestContext<'_>) -> Result<HttpRequest> {
        let messages: Vec<Value> = ctx
            .messages
            .iter()
            .map(|Message { role, content }| {
                json!({
                    "role": match role { Role::User => "user", Role::Assistant => "assistant" },
                    "content": content.iter().map(content_to_json).collect::<Vec<_>>(),
                })
            })
            .collect();

        let tools: Vec<Value> = ctx
            .tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.input_schema,
                })
            })
            .collect();

        let mut body = json!({
            "model": ctx.config.model,
            "max_tokens": ctx.config.max_tokens,
            "system": ctx.system,
            "messages": messages,
            "stream": true,
        });
        if !tools.is_empty() {
            body["tools"] = Value::Array(tools);
        }

        let mut headers = vec![
            ("content-type".into(), "application/json".into()),
            ("x-api-key".into(), ctx.config.api_key.clone()),
            ("anthropic-version".into(), API_VERSION.into()),
        ];
        if ctx.config.browser_direct {
            // Without this Anthropic rejects requests with a browser Origin.
            headers.push((
                "anthropic-dangerous-direct-browser-access".into(),
                "true".into(),
            ));
        }

        Ok(HttpRequest {
            method: "POST",
            url: format!("{}/v1/messages", ctx.config.base()),
            headers,
            body: body.to_string(),
        })
    }

    fn on_event(&self, event: &SseEvent) -> Result<Vec<Delta>> {
        let kind = event.event.as_deref().unwrap_or("");
        // `ping` carries no payload and message_stop needs no parsing.
        if kind == "ping" || kind == "message_stop" || event.data.is_empty() {
            return Ok(Vec::new());
        }

        let value: Value =
            serde_json::from_str(&event.data).map_err(|e| OfxError::decode(NAME, e))?;

        let deltas = match kind {
            "error" => {
                let detail = value["error"]["message"]
                    .as_str()
                    .unwrap_or("unknown error")
                    .to_string();
                return Err(OfxError::decode(NAME, detail));
            }

            "message_start" => {
                let usage = &value["message"]["usage"];
                vec![Delta::Usage {
                    input_tokens: usage["input_tokens"].as_u64().unwrap_or(0) as u32,
                    output_tokens: usage["output_tokens"].as_u64().unwrap_or(0) as u32,
                }]
            }

            "content_block_start" => {
                let index = value["index"].as_u64().unwrap_or(0) as usize;
                let block = &value["content_block"];
                if block["type"] == "tool_use" {
                    vec![Delta::ToolCallStart {
                        index,
                        id: block["id"].as_str().unwrap_or_default().to_string(),
                        name: block["name"].as_str().unwrap_or_default().to_string(),
                    }]
                } else {
                    Vec::new()
                }
            }

            "content_block_delta" => {
                let index = value["index"].as_u64().unwrap_or(0) as usize;
                let delta = &value["delta"];
                match delta["type"].as_str() {
                    Some("text_delta") => match delta["text"].as_str() {
                        Some(text) => vec![Delta::Text(text.to_string())],
                        None => Vec::new(),
                    },
                    Some("input_json_delta") => match delta["partial_json"].as_str() {
                        Some(fragment) => vec![Delta::ToolCallArgs {
                            index,
                            fragment: fragment.to_string(),
                        }],
                        None => Vec::new(),
                    },
                    _ => Vec::new(),
                }
            }

            "message_delta" => {
                let mut out = Vec::new();
                if let Some(reason) = value["delta"]["stop_reason"].as_str() {
                    out.push(Delta::Stop(match reason {
                        "tool_use" => StopReason::ToolUse,
                        "max_tokens" => StopReason::MaxTokens,
                        _ => StopReason::EndTurn,
                    }));
                }
                if let Some(output) = value["usage"]["output_tokens"].as_u64() {
                    out.push(Delta::Usage {
                        input_tokens: 0,
                        output_tokens: output as u32,
                    });
                }
                out
            }

            _ => Vec::new(),
        };

        Ok(deltas)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{ModelConfig, ProviderId};
    use crate::tool::builtin_tools;

    fn ctx_request() -> HttpRequest {
        let config = ModelConfig::new(ProviderId::Anthropic, "sk-test");
        let tools = builtin_tools();
        let messages = vec![Message::user("hello")];
        Anthropic
            .build_request(&RequestContext {
                system: "be brief",
                messages: &messages,
                tools: &tools,
                config: &config,
            })
            .unwrap()
    }

    #[test]
    fn builds_a_messages_request() {
        let req = ctx_request();
        assert_eq!(req.url, "https://api.anthropic.com/v1/messages");
        assert!(
            req.headers
                .iter()
                .any(|(k, v)| k == "x-api-key" && v == "sk-test")
        );
        assert!(req.headers.iter().any(|(k, _)| k == "anthropic-version"));

        let body: Value = serde_json::from_str(&req.body).unwrap();
        assert_eq!(body["stream"], true);
        assert_eq!(body["system"], "be brief");
        assert_eq!(body["messages"][0]["content"][0]["text"], "hello");
        assert_eq!(body["tools"][0]["name"], "bash");
        // Anthropic names the schema field input_schema, not parameters.
        assert!(body["tools"][0]["input_schema"].is_object());
    }

    #[test]
    fn omits_the_browser_header_by_default() {
        let req = ctx_request();
        assert!(
            !req.headers
                .iter()
                .any(|(k, _)| k == "anthropic-dangerous-direct-browser-access")
        );
    }

    #[test]
    fn adds_the_browser_header_when_asked() {
        let mut config = ModelConfig::new(ProviderId::Anthropic, "k");
        config.browser_direct = true;
        let messages = vec![Message::user("hi")];
        let req = Anthropic
            .build_request(&RequestContext {
                system: "",
                messages: &messages,
                tools: &[],
                config: &config,
            })
            .unwrap();
        assert!(
            req.headers
                .iter()
                .any(|(k, v)| k == "anthropic-dangerous-direct-browser-access" && v == "true")
        );
    }

    #[test]
    fn round_trips_tool_use_and_result_blocks() {
        let config = ModelConfig::new(ProviderId::Anthropic, "k");
        let messages = vec![
            Message::assistant(vec![Content::ToolUse {
                id: "tu_1".into(),
                name: "bash".into(),
                input: json!({ "command": "ls" }),
            }]),
            Message::tool_results(vec![Content::ToolResult {
                tool_use_id: "tu_1".into(),
                content: "README".into(),
                is_error: false,
            }]),
        ];
        let req = Anthropic
            .build_request(&RequestContext {
                system: "",
                messages: &messages,
                tools: &[],
                config: &config,
            })
            .unwrap();
        let body: Value = serde_json::from_str(&req.body).unwrap();

        assert_eq!(body["messages"][0]["role"], "assistant");
        assert_eq!(body["messages"][0]["content"][0]["type"], "tool_use");
        assert_eq!(body["messages"][0]["content"][0]["input"]["command"], "ls");
        // Tool results go back as a user turn.
        assert_eq!(body["messages"][1]["role"], "user");
        assert_eq!(body["messages"][1]["content"][0]["tool_use_id"], "tu_1");
    }

    fn event(kind: &str, data: &str) -> SseEvent {
        SseEvent {
            event: Some(kind.into()),
            data: data.into(),
        }
    }

    #[test]
    fn streams_text_deltas() {
        let deltas = Anthropic
            .on_event(&event(
                "content_block_delta",
                r#"{"index":0,"delta":{"type":"text_delta","text":"Hel"}}"#,
            ))
            .unwrap();
        assert_eq!(deltas, vec![Delta::Text("Hel".into())]);
    }

    #[test]
    fn streams_tool_calls_as_start_then_fragments() {
        let start = Anthropic
            .on_event(&event(
                "content_block_start",
                r#"{"index":1,"content_block":{"type":"tool_use","id":"tu_9","name":"bash"}}"#,
            ))
            .unwrap();
        assert_eq!(
            start,
            vec![Delta::ToolCallStart {
                index: 1,
                id: "tu_9".into(),
                name: "bash".into()
            }]
        );

        let args = Anthropic
            .on_event(&event(
                "content_block_delta",
                r#"{"index":1,"delta":{"type":"input_json_delta","partial_json":"{\"com"}}"#,
            ))
            .unwrap();
        assert_eq!(
            args,
            vec![Delta::ToolCallArgs {
                index: 1,
                fragment: "{\"com".into()
            }]
        );
    }

    #[test]
    fn maps_stop_reasons() {
        let deltas = Anthropic
            .on_event(&event(
                "message_delta",
                r#"{"delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}"#,
            ))
            .unwrap();
        assert!(deltas.contains(&Delta::Stop(StopReason::ToolUse)));
        assert!(deltas.contains(&Delta::Usage {
            input_tokens: 0,
            output_tokens: 42
        }));
    }

    #[test]
    fn surfaces_error_events() {
        let err = Anthropic
            .on_event(&event(
                "error",
                r#"{"error":{"type":"overloaded_error","message":"Overloaded"}}"#,
            ))
            .unwrap_err();
        assert!(err.to_string().contains("Overloaded"));
    }

    #[test]
    fn ignores_pings_and_unknown_events() {
        assert!(Anthropic.on_event(&event("ping", "")).unwrap().is_empty());
        assert!(
            Anthropic
                .on_event(&event("whatever", "{}"))
                .unwrap()
                .is_empty()
        );
    }
}
