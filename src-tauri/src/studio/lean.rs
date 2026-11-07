//! The agent's own environment. A turn runs on the person's inference login
//! and nothing else of their coding setup: no user settings, hooks, plugins,
//! skills, CLAUDE.md, or MCP servers, and for Astra no AGENTS.md, skills, or
//! MCP servers either. The workflow ships inside the app as a plugin.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

/// The only keys taken from the person's Claude Code settings: how inference
/// is reached. A token is passed to the agent's process and never stored.
const CLAUDE_INFERENCE_KEYS: [&str; 5] =
    ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "API_TIMEOUT_MS"];

/// The only variables the agent's process keeps from the app's own environment.
/// The app may have been started from a shell full of the person's setup, such
/// as `CLAUDE_CONFIG_DIR` or `CLAUDE_ENV_FILE`, and none of that may pass.
/// `CLAUDE_CONFIG_DIR` stays because it picks which Claude login the keychain
/// holds. The flags still keep that folder's settings, CLAUDE.md, and memory out.
pub const KEPT_ENV: [&str; 10] = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "CLAUDE_CONFIG_DIR"];

/// Set for the agent's process. `--setting-sources project` leaves out user
/// settings but not memory: without these the person's `~/.claude/CLAUDE.md`
/// (and every file it imports) and auto-memory still reach the agent.
pub const NO_MEMORY_ENV: [(&str, &str); 2] = [("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1"), ("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1")];

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSettings {
    #[serde(default)]
    env: HashMap<String, serde_json::Value>,
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
    /// The inference keys come from the settings, then from the app's own environment.
    /// With none of them the agent uses the normal keychain login.
    pub fn read(home: &Path) -> Result<Self, String> {
        let path = std::env::var_os("CLAUDE_CONFIG_DIR").map_or_else(|| home.join(".claude"), PathBuf::from).join("settings.json");
        let settings: ClaudeSettings = match std::fs::read_to_string(&path) {
            // Only the position: an error's own text can quote a value, and a value can be a token.
            Ok(text) => serde_json::from_str(&text)
                .map_err(|e| format!("{} is not valid settings JSON (line {}, column {})", path.display(), e.line(), e.column()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => ClaudeSettings::default(),
            Err(e) => return Err(format!("{}: {e}", path.display())),
        };
        let mut inference = Self::from_settings(settings);
        for key in CLAUDE_INFERENCE_KEYS {
            if !inference.env.iter().any(|(k, _)| k == key) {
                if let Some(value) = std::env::var_os(key).and_then(|v| v.into_string().ok()) {
                    inference.env.push((key.to_owned(), value));
                }
            }
        }
        Ok(inference)
    }

    fn from_settings(mut settings: ClaudeSettings) -> Self {
        let env = CLAUDE_INFERENCE_KEYS
            .iter()
            .filter_map(|&key| {
                let value = settings.env.remove(key)?;
                Some((key.to_owned(), value.as_str().map_or_else(|| value.to_string(), str::to_owned)))
            })
            .collect();
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

/// The provider keys Astra's config keeps. Anything else, such as an inline
/// bearer token or header, stays out, so no secret is written. The provider
/// reads its key with `auth.command` or from the `env_key` variable instead.
const PROVIDER_KEYS: [&str; 9] = [
    "name",
    "base_url",
    "wire_api",
    "env_key",
    "env_http_headers",
    "request_max_retries",
    "stream_max_retries",
    "stream_idle_timeout_ms",
    "auth",
];
const PROVIDER_AUTH_KEYS: [&str; 5] = ["command", "args", "cwd", "timeout_ms", "refresh_interval_ms"];

/// Writes Astra's own `CODEX_HOME` and returns it. Its `config.toml` holds only
/// the model and the cliproxy provider from `~/.codex/config.toml`, reads no
/// AGENTS.md, and turns off every skill under `~/.agents/skills`, which codex
/// would otherwise load. With no cliproxy provider the home has no way to reach
/// a model, so Astra fails and says so instead of running on the person's setup.
pub fn astra_home(home: &Path, app_data: &Path) -> Result<AstraHome, String> {
    let user_config = home.join(".codex").join("config.toml");
    // Astra runs only when the agent asks for it, so a codex config it cannot read
    // never stops a turn. Astra then has no model and says so when it is called.
    let user: toml::Table = match std::fs::read_to_string(&user_config) {
        // Only the position: an error's own text quotes the line, and a line can hold a token.
        Ok(text) => text.parse().unwrap_or_else(|e: toml::de::Error| {
            let at = e.span().map_or(String::new(), |span| format!(" at byte {}", span.start));
            log::warn!("studio: {} is not valid TOML{at}, so Astra cannot reach a model", user_config.display());
            toml::Table::new()
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => toml::Table::new(),
        Err(e) => {
            log::warn!("studio: cannot read {}: {e}, so Astra cannot reach a model", user_config.display());
            toml::Table::new()
        }
    };
    let AstraConfig { config, secrets } = astra_config(&user, &host_skills(home), |var| std::env::var_os(var).is_some());
    if !config.contains_key("model_providers") {
        log::warn!("studio: ~/.codex/config.toml has no cliproxy provider, so Astra cannot reach a model");
    }
    let env = provider_env_names(&config);
    let dir = app_data.join("astra");
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    remove_abandoned(&dir);
    // Written whole and then renamed, so an Astra starting meanwhile reads the old file or the new one.
    let staged = dir.join(format!("config.toml.{}", uuid::Uuid::new_v4()));
    let text = toml::to_string(&config).map_err(|e| format!("Astra config: {e}"))?;
    if let Err(e) = write_private(&staged, &text).and_then(|()| std::fs::rename(&staged, dir.join("config.toml"))) {
        let _ = std::fs::remove_file(&staged);
        return Err(format!("{}: {e}", dir.display()));
    }
    Ok(AstraHome { dir, env, secrets })
}

/// Removes staged configs a stopped app left before it could rename them. One
/// a minute old or more is not another turn's write in progress.
fn remove_abandoned(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
    for entry in entries.filter_map(Result::ok) {
        let staged = entry.file_name().to_string_lossy().starts_with("config.toml.");
        let old = entry.metadata().and_then(|m| m.modified()).is_ok_and(|modified| modified < cutoff);
        if staged && old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Astra's home, and the variables its provider reads its key from, which the
/// agent's process keeps when the app has them.
pub struct AstraHome {
    pub dir: PathBuf,
    /// Variables the provider reads, passed from the app's own environment when it has them.
    pub env: Vec<String>,
    /// Inline credentials from the person's config, passed by value and never written.
    pub secrets: Vec<(String, String)>,
}

/// The copied provider can name a key command's arguments, so the file is the
/// person's alone, like the config it came from.
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    std::io::Write::write_all(&mut options.open(path)?, text.as_bytes())
}

/// The variable names the provider reads: `env_key` and the values of `env_http_headers`.
fn provider_env_names(config: &toml::Table) -> Vec<String> {
    let Some(provider) = config.get("model_providers").and_then(|p| p.get("cliproxy")) else { return Vec::new() };
    let key = provider.get("env_key").and_then(toml::Value::as_str).map(str::to_owned);
    let headers = provider.get("env_http_headers").and_then(toml::Value::as_table).into_iter().flat_map(|table| table.values().filter_map(toml::Value::as_str).map(str::to_owned));
    key.into_iter().chain(headers).filter(|name| !name.starts_with("M3D_ASTRA_")).collect()
}

/// Astra's config, and the values of any inline credentials the provider had.
/// A credential written into the person's config (`experimental_bearer_token`,
/// or `http_headers`) is never copied. The new config names an environment
/// variable for it, and the value reaches Astra only through the process.
struct AstraConfig {
    config: toml::Table,
    secrets: Vec<(String, String)>,
}

/// `env_set` says whether a variable is set in the app's environment, which
/// decides whether an environment-backed header wins over a static one.
fn astra_config(user: &toml::Table, skills: &[PathBuf], env_set: impl Fn(&str) -> bool) -> AstraConfig {
    let keep = |table: &toml::Table, keys: &[&str]| -> toml::Table {
        table.iter().filter(|(key, _)| keys.contains(&key.as_str())).map(|(key, value)| (key.clone(), value.clone())).collect()
    };
    let mut config = toml::Table::new();
    let mut secrets = Vec::new();
    if let Some(model) = user.get("model") {
        config.insert("model".to_owned(), model.clone());
    }
    // No AGENTS.md from the project folder or any folder above it.
    config.insert("project_doc_max_bytes".to_owned(), 0.into());
    if let Some(provider) = user.get("model_providers").and_then(|p| p.get("cliproxy")).and_then(toml::Value::as_table) {
        let source = provider;
        let mut provider = keep(source, &PROVIDER_KEYS);
        if let Some(auth) = provider.get("auth").and_then(toml::Value::as_table) {
            let auth = keep(auth, &PROVIDER_AUTH_KEYS);
            provider.insert("auth".to_owned(), auth.into());
        }
        if let Some(token) = source.get("experimental_bearer_token").and_then(toml::Value::as_str) {
            provider.insert("env_key".to_owned(), ASTRA_BEARER_VAR.into());
            secrets.push((ASTRA_BEARER_VAR.to_owned(), token.to_owned()));
        }
        if let Some(headers) = source.get("http_headers").and_then(toml::Value::as_table) {
            let mut named = provider.get("env_http_headers").and_then(toml::Value::as_table).cloned().unwrap_or_default();
            for (index, (header, value)) in headers.iter().enumerate() {
                let Some(value) = value.as_str() else { continue };
                // Codex sends an environment-backed header over a static one when its variable is set, so that mapping stays.
                if named.get(header).and_then(toml::Value::as_str).is_some_and(|var| env_set(var)) {
                    continue;
                }
                let var = format!("{ASTRA_HEADER_VAR}{index}");
                named.insert(header.clone(), var.clone().into());
                secrets.push((var, value.to_owned()));
            }
            provider.insert("env_http_headers".to_owned(), named.into());
        }
        config.insert("model_provider".to_owned(), "cliproxy".into());
        config.insert("model_providers".to_owned(), toml::Table::from_iter([("cliproxy".to_owned(), provider.into())]).into());
    }
    let off: Vec<toml::Value> = skills
        .iter()
        .map(|path| toml::Table::from_iter([("path".to_owned(), path.display().to_string().into()), ("enabled".to_owned(), false.into())]).into())
        .collect();
    config.insert("skills".to_owned(), toml::Table::from_iter([("config".to_owned(), toml::Value::Array(off))]).into());
    AstraConfig { config, secrets }
}

/// The variables that carry an inline provider credential to Astra's process.
const ASTRA_BEARER_VAR: &str = "M3D_ASTRA_BEARER_TOKEN";
const ASTRA_HEADER_VAR: &str = "M3D_ASTRA_HEADER_";

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
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://proxy","ANTHROPIC_AUTH_TOKEN":"t","API_TIMEOUT_MS":60000,"LIFEOS_DIR":"/x"},
                "apiKeyHelper":"/usr/local/bin/key","hooks":{"Stop":[]}}"#,
        )
        .expect("settings");
        let inference = ClaudeInference::from_settings(settings);
        assert_eq!(
            inference.env,
            [("ANTHROPIC_BASE_URL", "https://proxy"), ("ANTHROPIC_AUTH_TOKEN", "t"), ("API_TIMEOUT_MS", "60000")].map(|(k, v)| (k.to_owned(), v.to_owned()))
        );
        let args = inference.args(Path::new("/app/studio-plugin"));
        assert!(args.windows(2).any(|w| w == ["--setting-sources", "project"]));
        assert!(args.windows(2).any(|w| w == ["--plugin-dir", "/app/studio-plugin"]));
        assert!(args.contains(&r#"{"apiKeyHelper":"/usr/local/bin/key"}"#.to_owned()));
    }

    #[test]
    fn an_environment_backed_header_keeps_winning_when_its_variable_is_set() {
        let user: toml::Table = r#"
            [model_providers.cliproxy]
            base_url = "https://mini:8317/v1"
            http_headers = { Authorization = "Bearer static" }
            env_http_headers = { Authorization = "PROXY_AUTH" }
        "#
        .parse()
        .expect("toml");
        let set = astra_config(&user, &[], |var| var == "PROXY_AUTH");
        assert_eq!(set.config["model_providers"]["cliproxy"]["env_http_headers"]["Authorization"].as_str(), Some("PROXY_AUTH"));
        assert!(set.secrets.is_empty(), "the static value is not used when the variable is set");
        let unset = astra_config(&user, &[], |_| false);
        let var = unset.config["model_providers"]["cliproxy"]["env_http_headers"]["Authorization"].as_str().expect("var").to_owned();
        assert_eq!(unset.secrets, [(var, "Bearer static".to_owned())], "without the variable, the static value is sent");
    }

    #[test]
    fn a_codex_config_astra_cannot_read_never_stops_a_turn() {
        let home = tempfile::tempdir().expect("home");
        let data = tempfile::tempdir().expect("data");
        std::fs::create_dir_all(home.path().join(".codex")).expect("codex dir");
        std::fs::write(home.path().join(".codex/config.toml"), "model = \"unterminated").expect("config");
        let astra = astra_home(home.path(), data.path()).expect("the turn goes on");
        let config: toml::Table = std::fs::read_to_string(astra.dir.join("config.toml")).expect("written").parse().expect("toml");
        assert!(config.get("model_providers").is_none(), "Astra has no model to reach");
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
            experimental_bearer_token = "secret-token"
            http_headers = { Authorization = "Bearer secret-token" }
            [model_providers.cliproxy.auth]
            command = "cat"
            args = ["/home/o/.config/codex/cliproxy-api-key"]
        "#
        .parse()
        .expect("toml");
        let AstraConfig { config, secrets } = astra_config(&user, &[PathBuf::from("/home/o/.agents/skills/a/SKILL.md")], |_| false);
        assert_eq!(config["model"].as_str(), Some("gpt-6.1-sol"));
        assert_eq!(config["model_providers"]["cliproxy"]["auth"]["command"].as_str(), Some("cat"));
        assert!(!toml::to_string(&config).expect("toml").contains("secret-token"), "no inline secret is copied");
        // The credentials still reach Astra, by value through its process.
        let cliproxy = &config["model_providers"]["cliproxy"];
        let bearer = cliproxy["env_key"].as_str().expect("env_key");
        let header = cliproxy["env_http_headers"]["Authorization"].as_str().expect("header var");
        assert!(secrets.contains(&(bearer.to_owned(), "secret-token".to_owned())));
        assert!(secrets.contains(&(header.to_owned(), "Bearer secret-token".to_owned())));
        assert!(config.get("mcp_servers").is_none(), "the person's MCP servers stay out");
        assert_eq!(config["project_doc_max_bytes"].as_integer(), Some(0));
        assert_eq!(config["skills"]["config"][0]["enabled"].as_bool(), Some(false));
        let no_proxy = astra_config(&"model = \"gpt\"".parse().expect("toml"), &[], |_| false).config;
        assert!(no_proxy.get("model_providers").is_none(), "with no cliproxy provider Astra reaches no model");
    }
}
