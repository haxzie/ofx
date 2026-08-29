use crate::error::{OfxError, Result};
use crate::host::Host;
use serde_json::{Value, json};

/// A tool as advertised to the model. Each provider re-frames this into its own
/// schema shape.
#[derive(Debug, Clone)]
pub struct ToolSchema {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
    })
}

/// The tool set. Unlike fx's browser build — which exposes a single 64 KiB
/// capped `terminal` call and tells the model git is unavailable — these speak
/// directly to the workspace and assume git works.
pub fn builtin_tools() -> Vec<ToolSchema> {
    vec![
        ToolSchema {
            name: "bash",
            description: "Run a shell command in the workspace and return its stdout, stderr and \
                          exit code. This is a real shell: git works, along with whatever else \
                          the system prompt lists. Use `command -v <name>` if unsure whether \
                          something is present.",
            input_schema: object(
                json!({ "command": { "type": "string", "description": "The command line to run." } }),
                &["command"],
            ),
        },
        ToolSchema {
            name: "read_file",
            description: "Read a file's full contents. Prefer this over `cat` so output is not \
                          truncated by the shell.",
            input_schema: object(
                json!({ "path": { "type": "string", "description": "Path to the file." } }),
                &["path"],
            ),
        },
        ToolSchema {
            name: "write_file",
            description: "Write a file, creating or overwriting it. To change part of an existing \
                          file, prefer edit_file.",
            input_schema: object(
                json!({
                    "path": { "type": "string" },
                    "contents": { "type": "string", "description": "The complete new file contents." }
                }),
                &["path", "contents"],
            ),
        },
        ToolSchema {
            name: "edit_file",
            description: "Replace an exact string in a file. old_string must appear exactly once, \
                          so include enough surrounding context to make it unique.",
            input_schema: object(
                json!({
                    "path": { "type": "string" },
                    "old_string": { "type": "string", "description": "Exact text to replace." },
                    "new_string": { "type": "string", "description": "Replacement text." }
                }),
                &["path", "old_string", "new_string"],
            ),
        },
        ToolSchema {
            name: "list_files",
            description: "List the entries directly inside a directory. Directories end with '/'.",
            input_schema: object(
                json!({ "path": { "type": "string", "description": "Directory to list." } }),
                &["path"],
            ),
        },
        ToolSchema {
            name: "glob_files",
            description: "Find files by glob pattern, for example 'src/**/*.rs'.",
            input_schema: object(json!({ "pattern": { "type": "string" } }), &["pattern"]),
        },
        ToolSchema {
            name: "grep_files",
            description: "Search file contents for a regular expression, returning matching lines \
                          with their file and line number.",
            input_schema: object(
                json!({
                    "pattern": { "type": "string", "description": "Regular expression to search for." },
                    "path": { "type": "string", "description": "File or directory to search. Defaults to the working directory." }
                }),
                &["pattern"],
            ),
        },
    ]
}

fn arg<'a>(input: &'a Value, tool: &str, key: &str) -> Result<&'a str> {
    input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| OfxError::tool(tool, format!("missing required string argument `{key}`")))
}

/// Cap on what a single tool result may contribute to the context.
const MAX_RESULT_BYTES: usize = 64 * 1024;

fn truncate(mut text: String) -> String {
    if text.len() <= MAX_RESULT_BYTES {
        return text;
    }
    // Never split a UTF-8 sequence.
    let mut end = MAX_RESULT_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let dropped = text.len() - end;
    text.truncate(end);
    text.push_str(&format!(
        "\n\n[truncated {dropped} bytes — narrow the request, e.g. with grep or a line range]"
    ));
    text
}

/// Run one tool call and render its result as the text the model will read.
pub async fn dispatch(host: &dyn Host, name: &str, input: &Value) -> Result<String> {
    let output = match name {
        "bash" => {
            let command = arg(input, name, "command")?;
            let result = host.exec(command).await?;
            let mut rendered = String::new();
            if !result.stdout.is_empty() {
                rendered.push_str(&result.stdout);
            }
            if !result.stderr.is_empty() {
                if !rendered.is_empty() && !rendered.ends_with('\n') {
                    rendered.push('\n');
                }
                rendered.push_str(&result.stderr);
            }
            if !result.ok() {
                rendered.push_str(&format!("\n[exit code {}]", result.exit_code));
            }
            if rendered.is_empty() {
                rendered.push_str("[no output]");
            }
            rendered
        }

        "read_file" => host.read_file(arg(input, name, "path")?).await?,

        "write_file" => {
            let path = arg(input, name, "path")?;
            let contents = arg(input, name, "contents")?;
            host.write_file(path, contents).await?;
            format!("Wrote {} bytes to {path}", contents.len())
        }

        "edit_file" => {
            let path = arg(input, name, "path")?;
            let old = arg(input, name, "old_string")?;
            let new = arg(input, name, "new_string")?;
            let current = host.read_file(path).await?;

            // Requiring a unique match is what makes blind edits safe: an
            // ambiguous pattern is a bug, not something to guess at.
            match current.matches(old).count() {
                0 => {
                    return Err(OfxError::tool(
                        name,
                        format!("old_string not found in {path}"),
                    ));
                }
                1 => {}
                n => {
                    return Err(OfxError::tool(
                        name,
                        format!(
                            "old_string appears {n} times in {path}; add surrounding context to make it unique"
                        ),
                    ));
                }
            }

            host.write_file(path, &current.replacen(old, new, 1))
                .await?;
            format!("Edited {path}")
        }

        "list_files" => {
            let entries = host.list_dir(arg(input, name, "path")?).await?;
            if entries.is_empty() {
                "[empty directory]".to_string()
            } else {
                entries.join("\n")
            }
        }

        "glob_files" => {
            let matches = host.glob(arg(input, name, "pattern")?).await?;
            if matches.is_empty() {
                "[no matches]".to_string()
            } else {
                matches.join("\n")
            }
        }

        "grep_files" => {
            let pattern = arg(input, name, "pattern")?;
            let path = input.get("path").and_then(Value::as_str).unwrap_or(".");
            let result = host
                .exec(&format!(
                    "grep -rnI -- {} {}",
                    shell_quote(pattern),
                    shell_quote(path)
                ))
                .await?;
            // grep exits 1 when nothing matched, which is not an error here.
            if result.stdout.is_empty() {
                "[no matches]".to_string()
            } else {
                result.stdout
            }
        }

        other => {
            return Err(OfxError::tool(other, "unknown tool"));
        }
    };

    Ok(truncate(output))
}

/// Wrap a value in single quotes for POSIX shells, escaping embedded quotes.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_values_safely() {
        assert_eq!(shell_quote("plain"), "'plain'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
        assert_eq!(shell_quote("a; rm -rf /"), "'a; rm -rf /'");
    }

    #[test]
    fn truncation_preserves_utf8_boundaries() {
        let text = "é".repeat(MAX_RESULT_BYTES);
        let out = truncate(text);
        assert!(out.contains("[truncated"));
        // Would have panicked or produced invalid UTF-8 on a bad split.
        assert!(out.is_char_boundary(0));
    }

    #[test]
    fn short_output_is_untouched() {
        assert_eq!(truncate("hello".into()), "hello");
    }

    #[test]
    fn every_tool_advertises_an_object_schema() {
        for tool in builtin_tools() {
            assert_eq!(tool.input_schema["type"], "object", "{}", tool.name);
            assert!(tool.input_schema["required"].is_array(), "{}", tool.name);
            assert!(!tool.description.is_empty(), "{}", tool.name);
        }
    }
}
