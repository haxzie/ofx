use crate::error::Result;
use async_trait::async_trait;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

impl ExecOutput {
    pub fn ok(&self) -> bool {
        self.exit_code == 0
    }
}

/// The workspace the agent acts on.
///
/// Deliberately small. Everything else — editing, searching, and all of git —
/// is built on top of these in `tool`, so the native host and the browser host
/// give the model identical behaviour. Notably `git` needs no special support:
/// natively it is real git on `PATH`, and in the browser `exec` routes to
/// just-bash with just-git registered as a command.
#[async_trait(?Send)]
pub trait Host {
    /// Run a shell command and capture its output.
    async fn exec(&self, command: &str) -> Result<ExecOutput>;

    async fn read_file(&self, path: &str) -> Result<String>;

    async fn write_file(&self, path: &str, contents: &str) -> Result<()>;

    /// Entry names directly under `path`, with a trailing `/` on directories.
    async fn list_dir(&self, path: &str) -> Result<Vec<String>>;

    /// Paths matching a glob pattern, relative to the workspace root.
    async fn glob(&self, pattern: &str) -> Result<Vec<String>>;

    /// Current working directory, used to orient the system prompt.
    fn cwd(&self) -> String;
}
