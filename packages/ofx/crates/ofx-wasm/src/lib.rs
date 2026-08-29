//! ofx in the browser.
//!
//! Binds the agent core to a JavaScript workspace and to `fetch`. The core is
//! unchanged from the native build — only this host layer differs.

mod host;
mod http;

use host::{JsHost, JsWorkspace};
use http::FetchClient;
use ofx_core::agent::{Agent, AgentConfig};
use ofx_core::event::{AgentEvent, EventSink};
use ofx_core::message::Message;
use ofx_core::provider::{ModelConfig, ProviderId};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// Surface a Rust panic as a console error instead of an opaque unreachable.
#[wasm_bindgen(start)]
pub fn start() {
    std::panic::set_hook(Box::new(|info| {
        web_sys::console::error_1(&JsValue::from_str(&format!("ofx panic: {info}")));
    }));
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsConfig {
    provider: String,
    api_key: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    max_tokens: Option<u32>,
    #[serde(default)]
    max_steps: Option<u32>,
    #[serde(default)]
    project_instructions: Option<String>,
    #[serde(default)]
    workspace_tools: Option<String>,
}

/// Forwards agent events to a JavaScript callback.
struct CallbackSink {
    callback: js_sys::Function,
}

impl EventSink for CallbackSink {
    fn emit(&mut self, event: AgentEvent) {
        // json_compatible matters: by default serde-wasm-bindgen turns a
        // serde_json map into a JS `Map`, so a tool's arguments would arrive as
        // something `input.path` cannot read.
        let serializer = serde_wasm_bindgen::Serializer::json_compatible();
        // A throwing or malformed callback must not abort the turn.
        if let Ok(value) = event.serialize(&serializer) {
            let _ = self.callback.call1(&JsValue::NULL, &value);
        }
    }
}

/// A configured agent bound to one workspace.
#[wasm_bindgen]
pub struct OfxAgent {
    host: JsHost,
    client: FetchClient,
    model: ModelConfig,
    config: AgentConfig,
    /// Conversation history, kept here so the borrowed `Agent` can be rebuilt
    /// per turn without losing context.
    messages: Vec<Message>,
}

#[wasm_bindgen]
impl OfxAgent {
    /// `config` is `{ provider, apiKey, model?, baseUrl?, maxTokens?, maxSteps?,
    /// projectInstructions? }`. `workspace` supplies `exec`, `readFile`,
    /// `writeFile`, `listDir`, `glob` and a `cwd` getter. `fetch` is optional
    /// and defaults to the global one.
    #[wasm_bindgen(constructor)]
    pub fn new(
        config: JsValue,
        workspace: JsWorkspace,
        fetch: Option<js_sys::Function>,
    ) -> std::result::Result<OfxAgent, JsValue> {
        let js: JsConfig = serde_wasm_bindgen::from_value(config)
            .map_err(|e| JsValue::from_str(&format!("invalid config: {e}")))?;

        let provider = ProviderId::parse(&js.provider)
            .ok_or_else(|| JsValue::from_str(&format!("unknown provider `{}`", js.provider)))?;

        let mut model = ModelConfig::new(provider, js.api_key);
        // Requests originate from a page, so Anthropic needs the opt-in header.
        model.browser_direct = true;
        if let Some(value) = js.model.filter(|v| !v.is_empty()) {
            model.model = value;
        }
        if let Some(value) = js.base_url.filter(|v| !v.is_empty()) {
            model.base_url = value;
        }
        if let Some(value) = js.max_tokens {
            model.max_tokens = value;
        }
        if model.base_url.is_empty() {
            return Err(JsValue::from_str("baseUrl is required for this provider"));
        }

        Ok(Self {
            host: JsHost::new(workspace),
            client: FetchClient::new(fetch).map_err(|e| JsValue::from_str(&e.to_string()))?,
            model,
            config: AgentConfig {
                max_steps: js.max_steps.unwrap_or(40),
                project_instructions: js.project_instructions,
                workspace_tools: js.workspace_tools,
            },
            messages: Vec::new(),
        })
    }

    /// Run one turn, invoking `on_event` for each streamed event. Resolves with
    /// the stop reason. Aborting `signal` cancels the in-flight model request.
    #[wasm_bindgen(js_name = runTurn)]
    pub async fn run_turn(
        &mut self,
        prompt: String,
        on_event: js_sys::Function,
        signal: Option<web_sys::AbortSignal>,
    ) -> std::result::Result<JsValue, JsValue> {
        self.client.set_signal(signal);
        let mut agent = Agent::new(
            &self.host,
            &self.client,
            self.model.clone(),
            self.config.clone(),
        );
        agent.set_messages(std::mem::take(&mut self.messages));

        let mut sink = CallbackSink { callback: on_event };
        let outcome = agent.run_turn(&prompt, &mut sink).await;

        // Keep the transcript either way: a failed turn should not erase the
        // conversation that led to it.
        self.messages = agent.messages().to_vec();
        self.client.set_signal(None);

        let stop = outcome.map_err(|e| JsValue::from_str(&e.to_string()))?;
        serde_wasm_bindgen::to_value(&stop).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Discard the conversation, keeping the configuration.
    pub fn clear(&mut self) {
        self.messages.clear();
    }

    /// Number of messages currently in the transcript.
    #[wasm_bindgen(js_name = messageCount)]
    pub fn message_count(&self) -> usize {
        self.messages.len()
    }
}

/// The providers this build supports, for populating a settings UI.
#[wasm_bindgen(js_name = providers)]
pub fn providers() -> JsValue {
    let list: Vec<_> = ProviderId::ALL
        .iter()
        .map(|p| {
            serde_json::json!({
                "id": p.as_str(),
                "baseUrl": p.default_base_url(),
                "model": p.default_model(),
            })
        })
        .collect();
    serde_wasm_bindgen::to_value(&list).unwrap_or(JsValue::NULL)
}
