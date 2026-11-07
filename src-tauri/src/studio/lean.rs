//! The agent's own environment. A turn runs on the person's inference login
//! and nothing else of their coding setup: no user settings, hooks, plugins,
//! skills, CLAUDE.md, or MCP servers, and for Astra no AGENTS.md, skills, or
//! MCP servers either. The workflow ships inside the app as a plugin.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

/// The only keys taken from the person's Claude Code settings: how inference
/// is reached. The token is passed to the agent's process and never stored.
const CLAUDE_INFERENCE_KEYS: [&str; 3] = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "API_TIMEOUT_MS"];

/// Set for the agent's process. `--setting-sources project` leaves out user
/// settings but not memory: without these the person's `~/.claude/CLAUDE.md`
/// (and every file it imports) and auto-memory still reach the agent.
pub const NO_MEMORY_ENV: [(&str, &str); 2] = [("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1"), ("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1")];

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSettings {
    #[serde(default)]
    env: HashMap<String, String>,
    api_key_helper: Option<String>,
}

/// How the agent reaches Claude, read from `~/.claude/settings.json`.
#[derive(Debug, Default)]
pub struct ClaudeInference {
    /// Environment for the agent's process.
    pub env: Vec<(String, String)>,
    /// A command that prints a key, passed with `--settings`. It names a program, not a secret.
    pub api_key_helper: Option<String>,
}

impl ClaudeInference {
    /// With no settings file, or none of these keys, the agent uses the normal keychain login.
    pub fn read(home: &Path) -> Result<Self, String> {
        let path = std::env::var_os("CLAUDE_CONFIG_DIR").map_or_else(|| home.join(".claude"), PathBuf::from).join("settings.json");
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(format!("{}: {e}", path.display())),
        };
        let settings: ClaudeSettings = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(Self::from_settings(settings))
    }

    fn from_settings(mut settings: ClaudeSettings) -> Self {
        let env = CLAUDE_INFERENCE_KEYS.iter().filter_map(|&key| settings.env.remove(key).map(|value| (key.to_owned(), value))).collect();
        Self { env, api_key_helper: settings.api_key_helper }
    }

    /// The Claude Code arguments that leave out the person's setup and add the app's plugin.
    pub fn args(&self, plugin: &Path) -> Vec<String> {
        let mut args = vec![
            // Settings from the project folder only. User settings, hooks, and plugins stay out.
            "--setting-sources".to_owned(),
            "project".to_owned(),
            // The app's own MCP servers, none yet. The person's servers stay out.
            "--strict-mcp-config".to_owned(),
            "--mcp-config".to_owned(),
            r#"{"mcpServers":{}}"#.to_owned(),
            "--plugin-dir".to_owned(),
            plugin.display().to_string(),
        ];
        if let Some(helper) = &self.api_key_helper {
            args.push("--settings".to_owned());
            args.push(serde_json::json!({ "apiKeyHelper": helper }).to_string());
        }
        args
    }
}

/// Writes Astra's own `CODEX_HOME` and returns it. Its `config.toml` holds only
/// the model and the cliproxy provider from `~/.codex/config.toml`, and turns off
/// every skill under `~/.agents/skills`, which codex would otherwise load. The
/// provider reads its key from a file, so no secret is copied. Returns `None`
/// when the person's codex has no cliproxy provider, and Astra then runs on
/// their normal codex setup.
pub fn astra_home(home: &Path, app_data: &Path) -> Result<Option<PathBuf>, String> {
    let user_config = std::env::var_os("CODEX_HOME").map_or_else(|| home.join(".codex"), PathBuf::from).join("config.toml");
    let text = match std::fs::read_to_string(&user_config) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}: {e}", user_config.display())),
    };
    let user: toml::Table = text.parse().map_err(|e| format!("{}: {e}", user_config.display()))?;
    let Some(config) = astra_config(&user, &host_skills(home)) else {
        log::warn!("studio: ~/.codex/config.toml has no cliproxy provider, so Astra uses the normal codex setup");
        return Ok(None);
    };
    let dir = app_data.join("astra");
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    std::fs::write(dir.join("config.toml"), config).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(Some(dir))
}

fn astra_config(user: &toml::Table, skills: &[PathBuf]) -> Option<String> {
    let provider = user.get("model_providers")?.get("cliproxy")?.clone();
    let mut config = toml::Table::new();
    if let Some(model) = user.get("model") {
        config.insert("model".to_owned(), model.clone());
    }
    config.insert("model_provider".to_owned(), "cliproxy".into());
    config.insert("model_providers".to_owned(), toml::Table::from_iter([("cliproxy".to_owned(), provider)]).into());
    let off: Vec<toml::Value> = skills
        .iter()
        .map(|path| toml::Table::from_iter([("path".to_owned(), path.display().to_string().into()), ("enabled".to_owned(), false.into())]).into())
        .collect();
    config.insert("skills".to_owned(), toml::Table::from_iter([("config".to_owned(), toml::Value::Array(off))]).into());
    toml::to_string(&config).ok()
}

/// Every `SKILL.md` under `~/.agents/skills`, at any depth, as codex finds them.
fn host_skills(home: &Path) -> Vec<PathBuf> {
    walkdir::WalkDir::new(home.join(".agents").join("skills"))
        .follow_links(true)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && entry.file_name() == "SKILL.md")
        .map(walkdir::DirEntry::into_path)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_inference_keys_and_key_helper_leave_the_claude_settings() {
        let settings: ClaudeSettings = serde_json::from_str(
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://proxy","ANTHROPIC_AUTH_TOKEN":"t","API_TIMEOUT_MS":"60000","LIFEOS_DIR":"/x"},
                "apiKeyHelper":"/usr/local/bin/key","hooks":{"Stop":[]}}"#,
        )
        .expect("settings");
        let inference = ClaudeInference::from_settings(settings);
        let keys: Vec<&str> = inference.env.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "API_TIMEOUT_MS"]);
        let args = inference.args(Path::new("/app/studio-plugin"));
        assert!(args.windows(2).any(|w| w == ["--setting-sources", "project"]));
        assert!(args.windows(2).any(|w| w == ["--plugin-dir", "/app/studio-plugin"]));
        assert!(args.contains(&r#"{"apiKeyHelper":"/usr/local/bin/key"}"#.to_owned()));
    }

    #[test]
    fn astra_keeps_the_model_and_provider_and_turns_off_host_skills() {
        let user: toml::Table = r#"
            model = "gpt-6.1-sol"
            model_provider = "cliproxy"
            [mcp_servers.lifeos]
            command = "lifeos"
            [model_providers.cliproxy]
            base_url = "https://mini:8317/v1"
            wire_api = "responses"
            [model_providers.cliproxy.auth]
            command = "cat"
            args = ["/home/o/.config/codex/cliproxy-api-key"]
        "#
        .parse()
        .expect("toml");
        let config: toml::Table = astra_config(&user, &[PathBuf::from("/home/o/.agents/skills/a/SKILL.md")]).expect("config").parse().expect("toml");
        assert_eq!(config["model"].as_str(), Some("gpt-6.1-sol"));
        assert_eq!(config["model_providers"]["cliproxy"]["auth"]["command"].as_str(), Some("cat"));
        assert!(config.get("mcp_servers").is_none(), "the person's MCP servers stay out");
        assert_eq!(config["skills"]["config"][0]["enabled"].as_bool(), Some(false));
        let no_proxy: toml::Table = "model = \"gpt\"".parse().expect("toml");
        assert!(astra_config(&no_proxy, &[]).is_none());
    }
}
