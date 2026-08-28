use super::{Delta, Provider, RequestContext};
use crate::error::{OfxError, Result};
use crate::http::HttpRequest;
use crate::message::{Content, Message, Role, StopReason};
use crate::sse::SseEvent;
use serde_json::{Value, json};

const NAME: &str = "openai";

/// Adapter for the OpenAI Chat Completions wire format.
///
/// This one adapter also serves Moonshot/Kimi, GLM/Zhipu and any other
/// OpenAI-compatible endpoint — they differ only by base URL and model id.
pub struct OpenAi {
    /// OpenAI's newer models reject `max_tokens` and require
    /// `max_completion_tokens`; the compatible clones still expect the old
    /// field, so the choice follows the endpoint.
    uses_max_completion_tokens: bool,
}

impl OpenAi {
    pub fn new(uses_max_completion_tokens: bool) -> Self {
        Self {
            uses_max_completion_tokens,
        }
    }
}

/// Chat Completions has no content blocks: an assistant turn carries `content`
/// plus a parallel `tool_calls` array, and every tool result is its own
/// `role: "tool"` message.
fn push_messages(out: &mut Vec<Value>, message: &Message) {
    match message.role {
        Role::Assistant => {
            let mut text = String::new();
            let mut tool_calls = Vec::new();
            for content in &message.content {
                match content {
                    Content::Text { text: t } => text.push_str(t),
                    Content::ToolUse { id, name, input } => tool_calls.push(json!({
                        "id": id,
                        "type": "function",
                        "function": { "name": name, "arguments": input.to_string() },
                    })),
                    Content::ToolResult { .. } => {}
                }
            }
            let mut msg = json!({ "role": "assistant" });
            // `content` must be present, and null is the correct value for a
            // turn that was purely tool calls.
            msg["content"] = if text.is_empty() {
                Value::Null
            } else {
                Value::String(text)
            };
            if !tool_calls.is_empty() {
                msg["tool_calls"] = Value::Array(tool_calls);
            }
            out.push(msg);
        }
        Role::User => {
            let mut text = String::new();
            for content in &message.content {
                match content {
                    Content::Text { text: t } => text.push_str(t),
                    Content::ToolResult {
                        tool_use_id,
                        content,
                        ..
                    } => out.push(json!({
                        "role": "tool",
                        "tool_call_id": tool_use_id,
                        "content": content,
                    })),
                    Content::ToolUse { .. } => {}
                }
            }
            if !text.is_empty() {
                out.push(json!({ "role": "user", "content": text }));
            }
        }
    }
}

impl Provider for OpenAi {
    fn name(&self) -> &'static str {
        NAME
    }

    fn build_request(&self, ctx: &RequestContext<'_>) -> Result<HttpRequest> {
        let mut messages = Vec::new();
        if !ctx.system.is_empty() {
            messages.push(json!({ "role": "system", "content": ctx.system }));
        }
        for message in ctx.messages {
            push_messages(&mut messages, message);
        }

        let tools: Vec<Value> = ctx
            .tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema,
                    },
                })
            })
            .collect();

        let mut body = json!({
            "model": ctx.config.model,
            "messages": messages,
            "stream": true,
            // Usage is omitted from streamed responses unless requested.
            "stream_options": { "include_usage": true },
        });
        let token_field = if self.uses_max_completion_tokens {
            "max_completion_tokens"
        } else {
            "max_tokens"
        };
        body[token_field] = json!(ctx.config.max_tokens);
        if !tools.is_empty() {
            body["tools"] = Value::Array(tools);
        }

        Ok(HttpRequest {
            method: "POST",
            url: format!("{}/chat/completions", ctx.config.base()),
            headers: vec![
                ("content-type".into(), "application/json".into()),
                (
                    "authorization".into(),
                    format!("Bearer {}", ctx.config.api_key),
                ),
            ],
            body: body.to_string(),
        })
    }

    fn on_event(&self, event: &SseEvent) -> Result<Vec<Delta>> {
        if event.is_done_sentinel() || event.data.is_empty() {
            return Ok(Vec::new());
        }

        let value: Value =
            serde_json::from_str(&event.data).map_err(|e| OfxError::decode(NAME, e))?;

        if let Some(message) = value["error"]["message"].as_str() {
            return Err(OfxError::decode(NAME, message));
        }

        let mut deltas = Vec::new();

        if let Some(usage) = value.get("usage").filter(|u| !u.is_null()) {
            deltas.push(Delta::Usage {
                input_tokens: usage["prompt_tokens"].as_u64().unwrap_or(0) as u32,
                output_tokens: usage["completion_tokens"].as_u64().unwrap_or(0) as u32,
            });
        }

        let Some(choice) = value["choices"].get(0) else {
            return Ok(deltas);
        };
        let delta = &choice["delta"];

        if let Some(text) = delta["content"].as_str().filter(|t| !t.is_empty()) {
            deltas.push(Delta::Text(text.to_string()));
        }

        if let Some(calls) = delta["tool_calls"].as_array() {
            for call in calls {
                let index = call["index"].as_u64().unwrap_or(0) as usize;
                let function = &call["function"];
                // The first chunk for a call carries id and name; later chunks
                // carry only argument fragments.
                if let Some(name) = function["name"].as_str() {
                    deltas.push(Delta::ToolCallStart {
                        index,
                        id: call["id"]
                            .as_str()
                            .map(str::to_string)
                            // Some compatible servers omit ids entirely.
                            .unwrap_or_else(|| format!("call_{index}")),
                        name: name.to_string(),
                    });
                }
                if let Some(fragment) = function["arguments"].as_str().filter(|f| !f.is_empty()) {
                    deltas.push(Delta::ToolCallArgs {
                        index,
                        fragment: fragment.to_string(),
                    });
                }
            }
        }

        if let Some(reason) = choice["finish_reason"].as_str() {
            deltas.push(Delta::Stop(match reason {
                "tool_calls" | "function_call" => StopReason::ToolUse,
                "length" => StopReason::MaxTokens,
                _ => StopReason::EndTurn,
            }));
        }

        Ok(deltas)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{ModelConfig, ProviderId};
    use crate::tool::builtin_tools;

    fn body_for(provider: &OpenAi, messages: &[Message], config: &ModelConfig) -> Value {
        let tools = builtin_tools();
        let req = provider
            .build_request(&RequestContext {
                system: "be brief",
                messages,
                tools: &tools,
                config,
            })
            .unwrap();
        serde_json::from_str(&req.body).unwrap()
    }

    #[test]
    fn builds_a_chat_completions_request() {
        let config = ModelConfig::new(ProviderId::Openai, "sk-test");
        let req = OpenAi::new(true)
            .build_request(&RequestContext {
                system: "sys",
                messages: &[Message::user("hi")],
                tools: &[],
                config: &config,
            })
            .unwrap();

        assert_eq!(req.url, "https://api.openai.com/v1/chat/completions");
        assert!(
            req.headers
                .iter()
                .any(|(k, v)| k == "authorization" && v == "Bearer sk-test")
        );
        let body: Value = serde_json::from_str(&req.body).unwrap();
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["content"], "hi");
        assert_eq!(body["stream_options"]["include_usage"], true);
    }

    #[test]
    fn picks_the_token_field_matching_the_endpoint() {
        let config = ModelConfig::new(ProviderId::Openai, "k");
        let openai = body_for(&OpenAi::new(true), &[Message::user("x")], &config);
        assert!(openai["max_completion_tokens"].is_number());
        assert!(openai["max_tokens"].is_null());

        // Moonshot and GLM still expect the original field.
        let compat = body_for(&OpenAi::new(false), &[Message::user("x")], &config);
        assert!(compat["max_tokens"].is_number());
        assert!(compat["max_completion_tokens"].is_null());
    }

    #[test]
    fn moonshot_and_glm_reuse_this_adapter() {
        for id in [ProviderId::Moonshot, ProviderId::Glm] {
            let config = ModelConfig::new(id, "k");
            let provider = id.build();
            assert_eq!(provider.name(), "openai");
            let req = provider
                .build_request(&RequestContext {
                    system: "",
                    messages: &[Message::user("x")],
                    tools: &[],
                    config: &config,
                })
                .unwrap();
            assert!(req.url.ends_with("/chat/completions"), "{}", req.url);
            assert!(req.url.starts_with(id.default_base_url()));
        }
    }

    #[test]
    fn flattens_tool_calls_and_results() {
        let config = ModelConfig::new(ProviderId::Openai, "k");
        let messages = vec![
            Message::assistant(vec![Content::ToolUse {
                id: "call_1".into(),
                name: "bash".into(),
                input: json!({ "command": "ls" }),
            }]),
            Message::tool_results(vec![Content::ToolResult {
                tool_use_id: "call_1".into(),
                content: "README".into(),
                is_error: false,
            }]),
        ];
        let body = body_for(&OpenAi::new(true), &messages, &config);
        let msgs = body["messages"].as_array().unwrap();

        let assistant = &msgs[1];
        assert_eq!(assistant["role"], "assistant");
        // A pure tool-call turn must send content: null, not omit it.
        assert!(assistant["content"].is_null());
        // Arguments are a JSON *string*, not an object.
        assert_eq!(
            assistant["tool_calls"][0]["function"]["arguments"],
            "{\"command\":\"ls\"}"
        );

        let tool = &msgs[2];
        assert_eq!(tool["role"], "tool");
        assert_eq!(tool["tool_call_id"], "call_1");
        assert_eq!(tool["content"], "README");
    }

    #[test]
    fn advertises_tools_under_function_parameters() {
        let config = ModelConfig::new(ProviderId::Openai, "k");
        let body = body_for(&OpenAi::new(true), &[Message::user("x")], &config);
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["function"]["name"], "bash");
        assert!(body["tools"][0]["function"]["parameters"].is_object());
    }

    fn data(payload: &str) -> SseEvent {
        SseEvent {
            event: None,
            data: payload.into(),
        }
    }

    #[test]
    fn streams_text_and_stops() {
        let p = OpenAi::new(true);
        assert_eq!(
            p.on_event(&data(r#"{"choices":[{"delta":{"content":"Hi"}}]}"#))
                .unwrap(),
            vec![Delta::Text("Hi".into())]
        );
        assert_eq!(
            p.on_event(&data(
                r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#
            ))
            .unwrap(),
            vec![Delta::Stop(StopReason::EndTurn)]
        );
    }

    #[test]
    fn streams_tool_calls_across_chunks() {
        let p = OpenAi::new(true);
        let first = p
            .on_event(&data(
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"bash","arguments":""}}]}}]}"#,
            ))
            .unwrap();
        assert_eq!(
            first,
            vec![Delta::ToolCallStart {
                index: 0,
                id: "call_a".into(),
                name: "bash".into()
            }]
        );

        let second = p
            .on_event(&data(
                r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"cmd\""}}]}}]}"#,
            ))
            .unwrap();
        assert_eq!(
            second,
            vec![Delta::ToolCallArgs {
                index: 0,
                fragment: "{\"cmd\"".into()
            }]
        );
    }

    #[test]
    fn synthesizes_an_id_when_the_server_omits_one() {
        let p = OpenAi::new(false);
        let deltas = p
            .on_event(&data(
                r#"{"choices":[{"delta":{"tool_calls":[{"index":2,"function":{"name":"read_file"}}]}}]}"#,
            ))
            .unwrap();
        assert_eq!(
            deltas,
            vec![Delta::ToolCallStart {
                index: 2,
                id: "call_2".into(),
                name: "read_file".into()
            }]
        );
    }

    #[test]
    fn maps_tool_calls_finish_reason() {
        let p = OpenAi::new(true);
        let deltas = p
            .on_event(&data(
                r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            ))
            .unwrap();
        assert_eq!(deltas, vec![Delta::Stop(StopReason::ToolUse)]);
    }

    #[test]
    fn reads_usage_and_ignores_the_done_sentinel() {
        let p = OpenAi::new(true);
        let deltas = p
            .on_event(&data(
                r#"{"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}"#,
            ))
            .unwrap();
        assert_eq!(
            deltas,
            vec![Delta::Usage {
                input_tokens: 11,
                output_tokens: 7
            }]
        );
        assert!(p.on_event(&data("[DONE]")).unwrap().is_empty());
    }

    #[test]
    fn surfaces_api_errors() {
        let p = OpenAi::new(true);
        let err = p
            .on_event(&data(r#"{"error":{"message":"invalid api key"}}"#))
            .unwrap_err();
        assert!(err.to_string().contains("invalid api key"));
    }
}
