/// The base system prompt.
///
/// Deliberately short. A long preamble costs tokens on every request and
/// competes with the actual task; the tool descriptions carry most of the
/// specifics.
const BASE: &str = "\
You are ofx, a coding agent working in a real repository.

Work directly. Read before you edit, make the smallest change that solves the \
problem, and match the conventions already in the file. Do not add comments, \
documentation, or tests that were not asked for.

You have a shell. git works: use `git status`, `git diff` and `git log` to \
understand the state of the tree, and stage or commit only when asked.

When you edit a file, prefer edit_file over rewriting it whole. Verify your \
work when there is a cheap way to do so — run the tests, the type checker, or \
the program itself.

Answer briefly. Explain what you changed and why, not what you are about to do.";

/// Build the system prompt for one session.
///
/// `tools` is a one-line description of what the host's shell actually
/// provides. Without it the model only knows about git, and will decline to
/// reach for anything else — correctly, since it was never told.
pub fn system_prompt(cwd: &str, tools: Option<&str>, extra: Option<&str>) -> String {
    let mut prompt = format!("{BASE}\n\nThe working directory is {cwd}.");
    if let Some(tools) = tools.map(str::trim).filter(|t| !t.is_empty()) {
        prompt.push_str("\n\nAvailable in the shell: ");
        prompt.push_str(tools);
    }
    if let Some(extra) = extra.map(str::trim).filter(|e| !e.is_empty()) {
        // Project instructions (AGENTS.md and the like) come last so they can
        // override the defaults above.
        prompt.push_str("\n\nProject instructions:\n");
        prompt.push_str(extra);
    }
    prompt
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn includes_the_working_directory() {
        assert!(system_prompt("/workspace", None, None).contains("/workspace"));
    }

    #[test]
    fn appends_project_instructions_last() {
        let prompt = system_prompt("/w", None, Some("Always use tabs."));
        assert!(prompt.contains("Project instructions:"));
        assert!(prompt.trim_end().ends_with("Always use tabs."));
    }

    #[test]
    fn ignores_blank_project_instructions() {
        assert!(!system_prompt("/w", None, Some("   ")).contains("Project instructions"));
        assert!(!system_prompt("/w", None, None).contains("Project instructions"));
    }

    #[test]
    fn advertises_the_host_shell_tools() {
        let prompt = system_prompt("/w", Some("gh, curl"), None);
        assert!(prompt.contains("Available in the shell: gh, curl"));
        // Without them the model is told nothing beyond the base prompt.
        assert!(!system_prompt("/w", None, None).contains("Available in the shell"));
        assert!(!system_prompt("/w", Some("  "), None).contains("Available in the shell"));
    }
}
