//! End-to-end tests for the turn loop, driven by a scripted provider stream and
//! a recording workspace. No network, no filesystem.

use async_trait::async_trait;
use futures::executor::block_on;
use ofx_core::agent::{Agent, AgentConfig};
use ofx_core::error::{OfxError, Result};
use ofx_core::event::{AgentEvent, EventSink};
use ofx_core::host::{ExecOutput, Host};
use ofx_core::http::{ByteStream, HttpClient, HttpRequest, HttpResponse};
use ofx_core::message::{Content, StopReason};
use ofx_core::provider::{ModelConfig, ProviderId};
use std::cell::RefCell;

// ------------------------------------------------------------------ test host

#[derive(Default)]
struct FakeHost {
    commands: RefCell<Vec<String>>,
    files: RefCell<Vec<(String, String)>>,
    exec_fails: bool,
}

#[async_trait(?Send)]
impl Host for FakeHost {
    async fn exec(&self, command: &str) -> Result<ExecOutput> {
        self.commands.borrow_mut().push(command.to_string());
        if self.exec_fails {
            return Err(OfxError::tool("bash", "shell unavailable"));
        }
        Ok(ExecOutput {
            stdout: format!("ran: {command}"),
            stderr: String::new(),
            exit_code: 0,
        })
    }

    async fn read_file(&self, path: &str) -> Result<String> {
        Ok(format!("contents of {path}"))
    }

    async fn write_file(&self, path: &str, contents: &str) -> Result<()> {
        self.files
            .borrow_mut()
            .push((path.to_string(), contents.to_string()));
        Ok(())
    }

    async fn list_dir(&self, _path: &str) -> Result<Vec<String>> {
        Ok(vec!["a.txt".into(), "src/".into()])
    }

    async fn glob(&self, _pattern: &str) -> Result<Vec<String>> {
        Ok(vec!["src/main.rs".into()])
    }

    fn cwd(&self) -> String {
        "/workspace".into()
    }
}

// ------------------------------------------------------------------ test http

struct Chunks(std::vec::IntoIter<Vec<u8>>);

#[async_trait(?Send)]
impl ByteStream for Chunks {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>> {
        Ok(self.0.next())
    }
}

/// Replays a scripted response per request, recording what was sent.
struct ScriptedHttp {
    responses: RefCell<std::vec::IntoIter<(u16, Vec<String>)>>,
    sent: RefCell<Vec<HttpRequest>>,
}

impl ScriptedHttp {
    fn new(responses: Vec<(u16, Vec<String>)>) -> Self {
        Self {
            responses: RefCell::new(responses.into_iter()),
            sent: RefCell::new(Vec::new()),
        }
    }

    /// Convenience: one 200 response whose body is these SSE frames.
    fn ok(bodies: Vec<Vec<String>>) -> Self {
        Self::new(bodies.into_iter().map(|b| (200, b)).collect())
    }
}

#[async_trait(?Send)]
impl HttpClient for ScriptedHttp {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse> {
        self.sent.borrow_mut().push(request);
        let (status, frames) = self
            .responses
            .borrow_mut()
            .next()
            .expect("more requests than scripted responses");
        let chunks: Vec<Vec<u8>> = frames.into_iter().map(|f| f.into_bytes()).collect();
        Ok(HttpResponse {
            status,
            body: Box::new(Chunks(chunks.into_iter())),
        })
    }
}

// ------------------------------------------------------------------- helpers

/// One Anthropic-shaped SSE frame.
fn frame(event: &str, data: &str) -> String {
    format!("event: {event}\ndata: {data}\n\n")
}

/// A response in which the model calls `bash` with the given command.
fn tool_call_response(command: &str) -> Vec<String> {
    vec![
        frame(
            "message_start",
            r#"{"message":{"usage":{"input_tokens":10,"output_tokens":0}}}"#,
        ),
        frame(
            "content_block_start",
            r#"{"index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"bash"}}"#,
        ),
        // Split mid-JSON to exercise fragment reassembly.
        frame(
            "content_block_delta",
            r#"{"index":0,"delta":{"type":"input_json_delta","partial_json":"{\"command\":"}}"#,
        ),
        frame(
            "content_block_delta",
            &format!(
                r#"{{"index":0,"delta":{{"type":"input_json_delta","partial_json":"\"{command}\"}}"}}}}"#
            ),
        ),
        frame(
            "message_delta",
            r#"{"delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}"#,
        ),
    ]
}

/// A response in which the model just talks and finishes.
fn text_response(text: &str) -> Vec<String> {
    vec![
        frame(
            "content_block_delta",
            &format!(r#"{{"index":0,"delta":{{"type":"text_delta","text":"{text}"}}}}"#),
        ),
        frame(
            "message_delta",
            r#"{"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}"#,
        ),
    ]
}

fn agent<'a>(host: &'a FakeHost, http: &'a ScriptedHttp, config: AgentConfig) -> Agent<'a> {
    let model = ModelConfig::new(ProviderId::Anthropic, "test-key");
    Agent::new(host, http, model, config)
}

#[derive(Default)]
struct Recorder(Vec<AgentEvent>);

impl EventSink for Recorder {
    fn emit(&mut self, event: AgentEvent) {
        self.0.push(event);
    }
}

// --------------------------------------------------------------------- tests

#[test]
fn runs_a_tool_then_finishes() {
    let host = FakeHost::default();
    let http = ScriptedHttp::ok(vec![tool_call_response("ls -la"), text_response("done")]);
    let mut sink = Recorder::default();

    let stop = block_on(async {
        agent(&host, &http, AgentConfig::default())
            .run_turn("list the files", &mut sink)
            .await
    })
    .unwrap();

    assert_eq!(stop, StopReason::EndTurn);
    // The reassembled arguments reached the workspace intact.
    assert_eq!(host.commands.borrow().as_slice(), ["ls -la"]);
    // Two rounds: the tool call, then the reply.
    assert_eq!(http.sent.borrow().len(), 2);

    let started = sink.0.iter().any(|e| {
        matches!(e, AgentEvent::ToolStart { name, input, .. }
            if name == "bash" && input["command"] == "ls -la")
    });
    assert!(started, "expected a ToolStart event: {:?}", sink.0);

    let ended = sink.0.iter().any(|e| {
        matches!(e, AgentEvent::ToolEnd { output, is_error, .. }
            if output.contains("ran: ls -la") && !is_error)
    });
    assert!(ended, "expected a successful ToolEnd: {:?}", sink.0);

    assert!(matches!(
        sink.0.last(),
        Some(AgentEvent::TurnComplete {
            stop: StopReason::EndTurn,
            ..
        })
    ));
}

#[test]
fn records_the_tool_exchange_in_the_transcript() {
    let host = FakeHost::default();
    let http = ScriptedHttp::ok(vec![tool_call_response("pwd"), text_response("ok")]);
    let mut a = agent(&host, &http, AgentConfig::default());

    block_on(a.run_turn("where am i", &mut Recorder::default())).unwrap();

    // user, assistant(tool_use), user(tool_result), assistant(text)
    let messages = a.messages();
    assert_eq!(messages.len(), 4);
    assert!(matches!(
        messages[1].content[0],
        Content::ToolUse { ref name, .. } if name == "bash"
    ));
    assert!(matches!(
        messages[2].content[0],
        Content::ToolResult { ref tool_use_id, is_error: false, .. } if tool_use_id == "tu_1"
    ));
    assert_eq!(messages[3].text(), "ok");
}

#[test]
fn accumulates_usage_across_steps() {
    let host = FakeHost::default();
    let http = ScriptedHttp::ok(vec![tool_call_response("ls"), text_response("fine")]);
    let mut sink = Recorder::default();

    block_on(agent(&host, &http, AgentConfig::default()).run_turn("go", &mut sink)).unwrap();

    let total = sink
        .0
        .iter()
        .find_map(|e| match e {
            AgentEvent::TurnComplete { usage, .. } => Some(*usage),
            _ => None,
        })
        .expect("TurnComplete");
    // 20 output tokens from the first step, 5 from the second.
    assert_eq!(total.output_tokens, 25);
    assert_eq!(total.input_tokens, 10);
}

#[test]
fn a_failing_tool_is_reported_to_the_model_and_the_turn_continues() {
    let host = FakeHost {
        exec_fails: true,
        ..Default::default()
    };
    let http = ScriptedHttp::ok(vec![
        tool_call_response("ls"),
        text_response("I could not run that"),
    ]);
    let mut sink = Recorder::default();

    let stop = block_on(agent(&host, &http, AgentConfig::default()).run_turn("go", &mut sink));

    // The tool failed but the turn completed normally.
    assert_eq!(stop.unwrap(), StopReason::EndTurn);
    let errored = sink.0.iter().any(|e| {
        matches!(e, AgentEvent::ToolEnd { is_error: true, output, .. }
            if output.contains("shell unavailable"))
    });
    assert!(errored, "expected a failed ToolEnd: {:?}", sink.0);
}

#[test]
fn malformed_tool_arguments_are_bounced_back_rather_than_dispatched() {
    let host = FakeHost::default();
    let broken = vec![
        frame(
            "content_block_start",
            r#"{"index":0,"content_block":{"type":"tool_use","id":"tu_x","name":"bash"}}"#,
        ),
        frame(
            "content_block_delta",
            r#"{"index":0,"delta":{"type":"input_json_delta","partial_json":"{not json"}}"#,
        ),
        frame("message_delta", r#"{"delta":{"stop_reason":"tool_use"}}"#),
    ];
    let http = ScriptedHttp::ok(vec![broken, text_response("sorry")]);
    let mut sink = Recorder::default();

    block_on(agent(&host, &http, AgentConfig::default()).run_turn("go", &mut sink)).unwrap();

    // Nothing reached the shell.
    assert!(host.commands.borrow().is_empty());
    let bounced = sink.0.iter().any(|e| {
        matches!(e, AgentEvent::ToolEnd { is_error: true, output, .. }
            if output.contains("not valid JSON"))
    });
    assert!(bounced, "expected a JSON complaint: {:?}", sink.0);
}

#[test]
fn surfaces_a_non_success_status_with_its_body() {
    let host = FakeHost::default();
    let http = ScriptedHttp::new(vec![(
        401,
        vec![r#"{"error":{"message":"invalid x-api-key"}}"#.to_string()],
    )]);

    let err = block_on(
        agent(&host, &http, AgentConfig::default()).run_turn("go", &mut Recorder::default()),
    )
    .unwrap_err();

    match err {
        OfxError::ProviderStatus {
            provider,
            status,
            body,
        } => {
            assert_eq!(provider, "anthropic");
            assert_eq!(status, 401);
            assert!(body.contains("invalid x-api-key"));
        }
        other => panic!("expected ProviderStatus, got {other:?}"),
    }
}

#[test]
fn stops_at_the_step_limit_instead_of_looping_forever() {
    let host = FakeHost::default();
    // Always asks for another tool call — never terminates on its own.
    let http = ScriptedHttp::ok(vec![
        tool_call_response("ls"),
        tool_call_response("ls"),
        tool_call_response("ls"),
    ]);
    let config = AgentConfig {
        max_steps: 3,
        ..Default::default()
    };

    let err =
        block_on(agent(&host, &http, config).run_turn("go", &mut Recorder::default())).unwrap_err();

    assert!(matches!(err, OfxError::StepLimit(3)));
    assert_eq!(host.commands.borrow().len(), 3);
}

#[test]
fn sends_the_system_prompt_and_tools_on_every_request() {
    let host = FakeHost::default();
    let http = ScriptedHttp::ok(vec![tool_call_response("ls"), text_response("ok")]);
    let config = AgentConfig {
        project_instructions: Some("Prefer tabs.".into()),
        ..Default::default()
    };

    block_on(agent(&host, &http, config).run_turn("go", &mut Recorder::default())).unwrap();

    for request in http.sent.borrow().iter() {
        let body: serde_json::Value = serde_json::from_str(&request.body).unwrap();
        let system = body["system"].as_str().unwrap();
        assert!(system.contains("/workspace"));
        assert!(system.contains("Prefer tabs."));
        assert!(body["tools"].as_array().unwrap().len() >= 7);
    }
}

#[test]
fn every_event_survives_json_serialization() {
    // The browser host serializes these across the wasm boundary with serde,
    // and internally-tagged enums reject newtype variants — so this asserts the
    // shape stays serializable.
    let host = FakeHost::default();
    let http = ScriptedHttp::ok(vec![tool_call_response("ls"), text_response("hi")]);
    let mut sink = Recorder::default();

    block_on(agent(&host, &http, AgentConfig::default()).run_turn("go", &mut sink)).unwrap();

    assert!(
        sink.0
            .iter()
            .any(|e| matches!(e, AgentEvent::TextDelta { .. }))
    );
    for event in &sink.0 {
        let json = serde_json::to_value(event)
            .unwrap_or_else(|e| panic!("{event:?} is not serializable: {e}"));
        assert!(json["type"].is_string(), "missing tag on {json}");
    }
}
