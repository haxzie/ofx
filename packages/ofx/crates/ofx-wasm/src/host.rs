use async_trait::async_trait;
use ofx_core::error::{OfxError, Result};
use ofx_core::host::{ExecOutput, Host};
use serde::Deserialize;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

#[wasm_bindgen]
extern "C" {
    /// The JavaScript workspace the agent acts on.
    ///
    /// In wowsm this is backed by just-bash over a persistent virtual
    /// filesystem, with just-git registered as a shell command — which is why
    /// `git` needs no special support here.
    #[wasm_bindgen(typescript_type = "OfxWorkspace")]
    pub type JsWorkspace;

    #[wasm_bindgen(method, catch)]
    fn exec(this: &JsWorkspace, command: &str) -> std::result::Result<js_sys::Promise, JsValue>;

    #[wasm_bindgen(method, js_name = readFile, catch)]
    fn read_file(this: &JsWorkspace, path: &str) -> std::result::Result<js_sys::Promise, JsValue>;

    #[wasm_bindgen(method, js_name = writeFile, catch)]
    fn write_file(
        this: &JsWorkspace,
        path: &str,
        contents: &str,
    ) -> std::result::Result<js_sys::Promise, JsValue>;

    #[wasm_bindgen(method, js_name = listDir, catch)]
    fn list_dir(this: &JsWorkspace, path: &str) -> std::result::Result<js_sys::Promise, JsValue>;

    #[wasm_bindgen(method, catch)]
    fn glob(this: &JsWorkspace, pattern: &str) -> std::result::Result<js_sys::Promise, JsValue>;

    #[wasm_bindgen(method, getter)]
    fn cwd(this: &JsWorkspace) -> String;
}

/// Turn a thrown JS value into a message worth showing the model.
fn js_error(tool: &str, value: JsValue) -> OfxError {
    let detail = value
        .dyn_ref::<js_sys::Error>()
        .map(|e| String::from(e.message()))
        .or_else(|| value.as_string())
        .unwrap_or_else(|| format!("{value:?}"));
    OfxError::tool(tool, detail)
}

async fn await_js(
    tool: &str,
    promise: std::result::Result<js_sys::Promise, JsValue>,
) -> Result<JsValue> {
    let promise = promise.map_err(|e| js_error(tool, e))?;
    JsFuture::from(promise).await.map_err(|e| js_error(tool, e))
}

fn as_string(tool: &str, value: JsValue) -> Result<String> {
    value
        .as_string()
        .ok_or_else(|| OfxError::tool(tool, "expected the host to resolve with a string"))
}

fn as_strings(tool: &str, value: JsValue) -> Result<Vec<String>> {
    serde_wasm_bindgen::from_value(value)
        .map_err(|e| OfxError::tool(tool, format!("expected an array of strings: {e}")))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsExecOutput {
    #[serde(default)]
    stdout: String,
    #[serde(default)]
    stderr: String,
    #[serde(default)]
    exit_code: i32,
}

pub struct JsHost {
    workspace: JsWorkspace,
}

impl JsHost {
    pub fn new(workspace: JsWorkspace) -> Self {
        Self { workspace }
    }
}

#[async_trait(?Send)]
impl Host for JsHost {
    async fn exec(&self, command: &str) -> Result<ExecOutput> {
        let value = await_js("bash", self.workspace.exec(command)).await?;
        let out: JsExecOutput = serde_wasm_bindgen::from_value(value).map_err(|e| {
            OfxError::tool(
                "bash",
                format!("expected {{stdout, stderr, exitCode}}: {e}"),
            )
        })?;
        Ok(ExecOutput {
            stdout: out.stdout,
            stderr: out.stderr,
            exit_code: out.exit_code,
        })
    }

    async fn read_file(&self, path: &str) -> Result<String> {
        as_string(
            "read_file",
            await_js("read_file", self.workspace.read_file(path)).await?,
        )
    }

    async fn write_file(&self, path: &str, contents: &str) -> Result<()> {
        await_js("write_file", self.workspace.write_file(path, contents)).await?;
        Ok(())
    }

    async fn list_dir(&self, path: &str) -> Result<Vec<String>> {
        as_strings(
            "list_files",
            await_js("list_files", self.workspace.list_dir(path)).await?,
        )
    }

    async fn glob(&self, pattern: &str) -> Result<Vec<String>> {
        as_strings(
            "glob_files",
            await_js("glob_files", self.workspace.glob(pattern)).await?,
        )
    }

    fn cwd(&self) -> String {
        self.workspace.cwd()
    }
}
