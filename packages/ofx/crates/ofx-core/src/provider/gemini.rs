use super::{Delta, Provider, RequestContext};
use crate::error::{OfxError, Result};
use crate::http::HttpRequest;
use crate::message::{Content, Message, Role, StopReason};
use crate::sse::SseEvent;
use serde_json::{Value, json};

const NAME: &str = "gemini";

/// Adapter for Google's Gemini `generateContent` API.
///
/// The most divergent of the three: assistant turns are role `model`, tools are
/// `functionDeclarations`, calls arrive whole rather than as JSON fragments,
/// and results are matched to calls by function *name* rather than by id.
pub struct Gemini;

/// Gemini's schema dialect is the OpenAPI subset, whose `type` values are
/// upper-case. Convert recursively so one tool definition serves every
/// provider.
fn to_gemini_schema(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (key, child) in map {
                let converted = if key == "type" {
                    match child.as_str() {
                        Some(t) => Value::String(t.to_ascii_uppercase()),
                        None => to_gemini_schema(child),
                    }
                } else {
                    to_gemini_schema(child)
                };
                out.insert(key.clone(), converted);
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(to_gemini_schema).collect()),
        other => other.clone(),
    }
}

/// Gemini identifies a function response by name, so results must be matched
/// back to the call that produced them.
fn tool_name_for(messages: &[Message], tool_use_id: &str) -> Option<String> {
    messages.iter().rev().find_map(|m| {
        m.tool_uses()
            .find(|(id, _, _)| *id == tool_use_id)
            .map(|(_, name, _)| name.to_string())
    })
}

impl Provider for Gemini {
    fn name(&self) -> &'static str {
        NAME
    }

    fn build_request(&self, ctx: &RequestContext<'_>) -> Result<HttpRequest> {
        let mut contents = Vec::new();

        for message in ctx.messages {
            let mut parts = Vec::new();
            for content in &message.content {
                match content {
                    Content::Text { text } if !text.is_empty() => {
                        parts.push(json!({ "text": text }));
                    }
                    Content::Text { .. } => {}
                    Content::ToolUse { name, input, .. } => {
                        parts.push(json!({ "functionCall": { "name": name, "args": input } }));
                    }
                    Content::ToolResult {
                        tool_use_id,
                        content,
                        is_error,
                    } => {
                        let name = tool_name_for(ctx.messages, tool_use_id).ok_or_else(|| {
                            OfxError::decode(
                                NAME,
                                format!("no tool call matches result id `{tool_use_id}`"),
                            )
                        })?;
                        let payload = if *is_error {
                            json!({ "error": content })
                        } else {
                            json!({ "result": content })
                        };
                        parts.push(json!({
                            "functionResponse": { "name": name, "response": payload }
                        }));
                    }
                }
            }
            if parts.is_empty() {
                continue;
            }
            contents.push(json!({
                "role": match message.role { Role::User => "user", Role::Assistant => "model" },
                "parts": parts,
            }));
        }

        let mut body = json!({
            "contents": contents,
            "generationConfig": { "maxOutputTokens": ctx.config.max_tokens },
        });

        if !ctx.system.is_empty() {
            body["systemInstruction"] = json!({ "parts": [{ "text": ctx.system }] });
        }

        if !ctx.tools.is_empty() {
            let declarations: Vec<Value> = ctx
                .tools
                .iter()
                .map(|t| {
                    json!({
                        "name": t.name,
                        "description": t.description,
                        "parameters": to_gemini_schema(&t.input_schema),
                    })
                })
                .collect();
            body["tools"] = json!([{ "functionDeclarations": declarations }]);
        }

        Ok(HttpRequest {
            method: "POST",
            url: format!(
                "{}/v1beta/models/{}:streamGenerateContent?alt=sse",
                ctx.config.base(),
                ctx.config.model
            ),
            headers: vec![
                ("content-type".into(), "application/json".into()),
                // Passed as a header rather than the documented `?key=` query
                // parameter, so the secret stays out of URLs and logs.
                ("x-goog-api-key".into(), ctx.config.api_key.clone()),
            ],
            body: body.to_string(),
        })
    }

    fn on_event(&self, event: &SseEvent) -> Result<Vec<Delta>> {
        if event.data.is_empty() {
            return Ok(Vec::new());
        }

        let value: Value =
            serde_json::from_str(&event.data).map_err(|e| OfxError::decode(NAME, e))?;

        if let Some(message) = value["error"]["message"].as_str() {
            return Err(OfxError::decode(NAME, message));
        }

        let mut deltas = Vec::new();

        if let Some(usage) = value.get("usageMetadata") {
            deltas.push(Delta::Usage {
                input_tokens: usage["promptTokenCount"].as_u64().unwrap_or(0) as u32,
                output_tokens: usage["candidatesTokenCount"].as_u64().unwrap_or(0) as u32,
            });
        }

        let Some(candidate) = value["candidates"].get(0) else {
            return Ok(deltas);
        };

        let mut saw_function_call = false;
        if let Some(parts) = candidate["content"]["parts"].as_array() {
            for (index, part) in parts.iter().enumerate() {
                if let Some(text) = part["text"].as_str().filter(|t| !t.is_empty()) {
                    deltas.push(Delta::Text(text.to_string()));
                }
                if let Some(call) = part.get("functionCall").filter(|c| !c.is_null()) {
                    saw_function_call = true;
                    let name = call["name"].as_str().unwrap_or_default().to_string();
                    // Gemini issues no call ids, so one is synthesized from the
                    // part's position; results are matched by name regardless.
                    deltas.push(Delta::ToolCallStart {
                        index,
                        id: format!("call_{index}_{name}"),
                        name,
                    });
                    // Arguments arrive complete rather than streamed.
                    let args = call.get("args").cloned().unwrap_or_else(|| json!({}));
                    deltas.push(Delta::ToolCallArgs {
                        index,
                        fragment: args.to_string(),
                    });
                }
            }
        }

        if let Some(reason) = candidate["finishReason"].as_str() {
            // Gemini reports STOP even when it is asking for a function call,
            // so the presence of calls decides the stop reason.
            deltas.push(Delta::Stop(if saw_function_call {
                StopReason::ToolUse
            } else {
                match reason {
                    "MAX_TOKENS" => StopReason::MaxTokens,
                    _ => StopReason::EndTurn,
                }
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

    fn request_for(messages: &[Message]) -> HttpRequest {
        let config = ModelConfig::new(ProviderId::Gemini, "k-test");
        let tools = builtin_tools();
        Gemini
            .build_request(&RequestContext {
                system: "be brief",
                messages,
                tools: &tools,
                config: &config,
            })
            .unwrap()
    }

    #[test]
    fn builds_a_streaming_url_and_keeps_the_key_in_a_header() {
        let req = request_for(&[Message::user("hi")]);
        assert_eq!(
            req.url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse"
        );
        assert!(
            req.headers
                .iter()
                .any(|(k, v)| k == "x-goog-api-key" && v == "k-test")
        );
        // The secret must not leak into the URL.
        assert!(!req.url.contains("k-test"));
    }

    #[test]
    fn uses_model_role_and_system_instruction() {
        let req = request_for(&[
            Message::user("hi"),
            Message::assistant(vec![Content::text("hello")]),
        ]);
        let body: Value = serde_json::from_str(&req.body).unwrap();
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "be brief");
        assert_eq!(body["contents"][0]["role"], "user");
        assert_eq!(body["contents"][1]["role"], "model");
    }

    #[test]
    fn uppercases_schema_types_for_the_openapi_dialect() {
        let req = request_for(&[Message::user("hi")]);
        let body: Value = serde_json::from_str(&req.body).unwrap();
        let decl = &body["tools"][0]["functionDeclarations"][0];
        assert_eq!(decl["name"], "bash");
        assert_eq!(decl["parameters"]["type"], "OBJECT");
        assert_eq!(
            decl["parameters"]["properties"]["command"]["type"],
            "STRING"
        );
    }

    #[test]
    fn matches_tool_results_back_to_their_call_by_name() {
        let messages = vec![
            Message::assistant(vec![Content::ToolUse {
                id: "call_0_bash".into(),
                name: "bash".into(),
                input: json!({ "command": "ls" }),
            }]),
            Message::tool_results(vec![Content::ToolResult {
                tool_use_id: "call_0_bash".into(),
                content: "README".into(),
                is_error: false,
            }]),
        ];
        let req = request_for(&messages);
        let body: Value = serde_json::from_str(&req.body).unwrap();

        assert_eq!(
            body["contents"][0]["parts"][0]["functionCall"]["name"],
            "bash"
        );
        let response = &body["contents"][1]["parts"][0]["functionResponse"];
        assert_eq!(response["name"], "bash");
        assert_eq!(response["response"]["result"], "README");
    }

    #[test]
    fn reports_an_unmatched_tool_result_rather_than_guessing() {
        let config = ModelConfig::new(ProviderId::Gemini, "k");
        let messages = vec![Message::tool_results(vec![Content::ToolResult {
            tool_use_id: "orphan".into(),
            content: "x".into(),
            is_error: false,
        }])];
        let err = Gemini
            .build_request(&RequestContext {
                system: "",
                messages: &messages,
                tools: &[],
                config: &config,
            })
            .unwrap_err();
        assert!(err.to_string().contains("orphan"));
    }

    fn data(payload: &str) -> SseEvent {
        SseEvent {
            event: None,
            data: payload.into(),
        }
    }

    #[test]
    fn streams_text() {
        let deltas = Gemini
            .on_event(&data(
                r#"{"candidates":[{"content":{"parts":[{"text":"Hi"}],"role":"model"}}]}"#,
            ))
            .unwrap();
        assert_eq!(deltas, vec![Delta::Text("Hi".into())]);
    }

    #[test]
    fn emits_whole_function_calls_as_start_plus_full_args() {
        let deltas = Gemini
            .on_event(&data(
                r#"{"candidates":[{"content":{"parts":[{"functionCall":{"name":"bash","args":{"command":"ls"}}}],"role":"model"},"finishReason":"STOP"}]}"#,
            ))
            .unwrap();

        assert_eq!(
            deltas[0],
            Delta::ToolCallStart {
                index: 0,
                id: "call_0_bash".into(),
                name: "bash".into()
            }
        );
        assert_eq!(
            deltas[1],
            Delta::ToolCallArgs {
                index: 0,
                fragment: "{\"command\":\"ls\"}".into()
            }
        );
        // STOP alongside a function call still means "run tools".
        assert_eq!(deltas[2], Delta::Stop(StopReason::ToolUse));
    }

    #[test]
    fn plain_stop_ends_the_turn() {
        let deltas = Gemini
            .on_event(&data(
                r#"{"candidates":[{"content":{"parts":[{"text":"done"}]},"finishReason":"STOP"}]}"#,
            ))
            .unwrap();
        assert!(deltas.contains(&Delta::Stop(StopReason::EndTurn)));
    }

    #[test]
    fn reads_usage_metadata_and_surfaces_errors() {
        let deltas = Gemini
            .on_event(&data(
                r#"{"candidates":[],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":9}}"#,
            ))
            .unwrap();
        assert_eq!(
            deltas,
            vec![Delta::Usage {
                input_tokens: 5,
                output_tokens: 9
            }]
        );

        let err = Gemini
            .on_event(&data(r#"{"error":{"message":"API key not valid"}}"#))
            .unwrap_err();
        assert!(err.to_string().contains("API key not valid"));
    }
}
