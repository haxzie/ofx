use async_trait::async_trait;
use ofx_core::error::{OfxError, Result};
use ofx_core::host::{ExecOutput, Host};
use std::path::{Path, PathBuf};

/// The workspace as real files and a real shell.
pub struct NativeHost {
    root: PathBuf,
    shell: String,
}

impl NativeHost {
    pub fn new(root: PathBuf) -> Self {
        Self {
            // A login shell would drag in the user's prompt and aliases; a
            // plain `sh -c` keeps behaviour predictable.
            shell: std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()),
            root,
        }
    }

    /// Resolve a model-supplied path against the workspace root.
    fn resolve(&self, path: &str) -> PathBuf {
        let candidate = Path::new(path);
        if candidate.is_absolute() {
            candidate.to_path_buf()
        } else {
            self.root.join(candidate)
        }
    }
}

fn io_err(action: &str, path: &Path, err: std::io::Error) -> OfxError {
    OfxError::tool(action, format!("{}: {err}", path.display()))
}

#[async_trait(?Send)]
impl Host for NativeHost {
    async fn exec(&self, command: &str) -> Result<ExecOutput> {
        let output = tokio::process::Command::new(&self.shell)
            .arg("-c")
            .arg(command)
            .current_dir(&self.root)
            .output()
            .await
            .map_err(|e| OfxError::tool("bash", e))?;

        Ok(ExecOutput {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            exit_code: output.status.code().unwrap_or(-1),
        })
    }

    async fn read_file(&self, path: &str) -> Result<String> {
        let full = self.resolve(path);
        tokio::fs::read_to_string(&full)
            .await
            .map_err(|e| io_err("read_file", &full, e))
    }

    async fn write_file(&self, path: &str, contents: &str) -> Result<()> {
        let full = self.resolve(path);
        if let Some(parent) = full.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| io_err("write_file", parent, e))?;
        }
        tokio::fs::write(&full, contents)
            .await
            .map_err(|e| io_err("write_file", &full, e))
    }

    async fn list_dir(&self, path: &str) -> Result<Vec<String>> {
        let full = self.resolve(path);
        let mut entries = tokio::fs::read_dir(&full)
            .await
            .map_err(|e| io_err("list_files", &full, e))?;

        let mut names = Vec::new();
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| io_err("list_files", &full, e))?
        {
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
            names.push(if is_dir { format!("{name}/") } else { name });
        }
        names.sort();
        Ok(names)
    }

    async fn glob(&self, pattern: &str) -> Result<Vec<String>> {
        let full = self.resolve(pattern);
        let matches = glob::glob(&full.to_string_lossy())
            .map_err(|e| OfxError::tool("glob_files", e))?
            .filter_map(std::result::Result::ok)
            .map(|p| {
                // Report paths relative to the root when possible; absolute
                // paths are noise for the model.
                p.strip_prefix(&self.root)
                    .unwrap_or(&p)
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        Ok(matches)
    }

    fn cwd(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }
}
