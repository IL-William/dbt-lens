//! Per-project settings, stored in the user's config directory.
//!
//! Deliberately never inside the project: a dbt repository is usually shared,
//! and one person's environment names do not belong in it.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const VERSION: u32 = 1;

#[derive(serde::Serialize, serde::Deserialize, Default, Clone, Debug, PartialEq)]
pub struct EnvOverride {
    /// None means the automatic name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// None means automatic: hidden only for templates, backups, and files that
    /// define none of the variables in use. A user can always override it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
}

#[derive(serde::Serialize, serde::Deserialize, Default, Clone, Debug)]
pub struct Settings {
    #[serde(default)]
    pub version: u32,
    /// The project these settings belong to, checked on load so that a hash
    /// collision can never apply someone else's names.
    #[serde(default)]
    pub project: String,
    #[serde(default)]
    pub envs: BTreeMap<String, EnvOverride>,
    /// Where a fresh browser tab starts; each tab then keeps its own choice.
    #[serde(default)]
    pub selected: Option<String>,
}

fn looks_absolute(value: &str, windows: bool) -> bool {
    if windows {
        let b = value.as_bytes();
        value.starts_with(r"\\") || (b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
    } else {
        value.starts_with('/')
    }
}

/// The dbt-lens config directory, or None when nothing usable is set, in which
/// case the app runs without persistence. Empty or relative values are ignored.
/// On Windows `HOME` is not consulted: under Git Bash it holds an MSYS path.
pub fn config_dir(lookup: impl Fn(&str) -> Option<OsString>, windows: bool) -> Option<PathBuf> {
    let get = |key: &str| {
        lookup(key)
            .map(|v| v.to_string_lossy().into_owned())
            .filter(|v| !v.is_empty() && looks_absolute(v, windows))
            .map(PathBuf::from)
    };
    if let Some(explicit) = get("DBT_LENS_CONFIG_DIR") {
        return Some(explicit);
    }
    let base = if windows {
        get("APPDATA").or_else(|| get("USERPROFILE").map(|p| p.join("AppData").join("Roaming")))
    } else {
        get("XDG_CONFIG_HOME").or_else(|| get("HOME").map(|p| p.join(".config")))
    };
    base.map(|p| p.join("dbt-lens"))
}

/// A stable spelling of the project path. Windows verbatim prefixes and
/// separators are normalised, so a change in how a path is displayed cannot
/// silently orphan the settings. Case is folded on Windows only: macOS and
/// Linux volumes can be case-sensitive.
pub fn normalise(root: &str, windows: bool) -> String {
    let mut s = if let Some(rest) = root.strip_prefix(r"\\?\UNC\") {
        format!("//{rest}")
    } else {
        root.strip_prefix(r"\\?\").unwrap_or(root).to_string()
    };
    s = s.replace('\\', "/");
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    if windows {
        s = s.to_lowercase();
    }
    s
}

pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// `<folder>-<hash>.json`: the folder name so a person can find the file, the
/// hash so two projects with the same folder name do not collide.
pub fn file_name(root: &str, windows: bool) -> String {
    let norm = normalise(root, windows);
    let folder = norm.rsplit('/').next().unwrap_or("");
    let slug: String = folder
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c.to_ascii_lowercase() } else { '_' })
        .take(40)
        .collect();
    let slug = if slug.is_empty() { "project".to_string() } else { slug };
    format!("{slug}-{:016x}.json", fnv1a64(norm.as_bytes()))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("json.tmp-{}", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    let mut last_error = None;
    for attempt in 0..3 {
        match std::fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_error = Some(e);
                if attempt < 2 {
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
    // On Windows an indexer or antivirus can hold the target long enough for
    // every rename to fail. Writing in place is less tidy than losing the change.
    let _ = std::fs::remove_file(&tmp);
    std::fs::write(path, bytes).map_err(|e| last_error.unwrap_or(e))
}

pub struct Store {
    pub path: Option<PathBuf>,
    project: String,
    lock: tokio::sync::Mutex<()>,
}

impl Store {
    pub fn new(root: &Path) -> Store {
        let windows = cfg!(windows);
        let root = root.to_string_lossy();
        Store {
            path: config_dir(|key| std::env::var_os(key), windows)
                .map(|dir| dir.join("projects").join(file_name(&root, windows))),
            project: normalise(&root, windows),
            lock: tokio::sync::Mutex::new(()),
        }
    }

    /// Defaults whenever there is nothing usable: no config directory, no file,
    /// a file for another project, or a corrupt one. A corrupt file is reported
    /// and left alone until the user next changes something.
    pub fn load(&self) -> Settings {
        let fresh = || Settings { version: VERSION, project: self.project.clone(), ..Default::default() };
        let Some(path) = &self.path else { return fresh() };
        let Ok(bytes) = std::fs::read(path) else { return fresh() };
        match serde_json::from_slice::<Settings>(&bytes) {
            Ok(s) if s.project == self.project => s,
            Ok(_) => fresh(),
            Err(e) => {
                eprintln!("  settings ignored, {} is not valid JSON: {e}", path.display());
                fresh()
            }
        }
    }

    /// Re-reads, applies the change and writes, all under one lock, so two
    /// requests cannot interleave and drop each other's change.
    pub async fn update(&self, change: impl FnOnce(&mut Settings)) -> Result<Settings, String> {
        let _guard = self.lock.lock().await;
        let mut settings = self.load();
        change(&mut settings);
        settings.version = VERSION;
        settings.project = self.project.clone();
        let Some(path) = &self.path else {
            return Err("no config directory available, settings cannot be saved".into());
        };
        let bytes = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
        write_atomic(path, &bytes).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        Ok(settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<OsString> {
        move |key| pairs.iter().find(|(k, _)| *k == key).map(|(_, v)| OsString::from(*v))
    }

    #[test]
    fn fnv1a64_matches_reference_vectors() {
        assert_eq!(format!("{:016x}", fnv1a64(b"")), "cbf29ce484222325");
        assert_eq!(format!("{:016x}", fnv1a64(b"a")), "af63dc4c8601ec8c");
    }

    #[test]
    fn config_dir_prefers_the_explicit_override() {
        let dir = config_dir(env(&[("DBT_LENS_CONFIG_DIR", "/tmp/lens"), ("HOME", "/home/me")]), false);
        assert_eq!(dir, Some(PathBuf::from("/tmp/lens")));
    }

    #[test]
    fn config_dir_on_unix_uses_xdg_then_home() {
        assert_eq!(config_dir(env(&[("XDG_CONFIG_HOME", "/xdg"), ("HOME", "/home/me")]), false), Some(PathBuf::from("/xdg/dbt-lens")));
        assert_eq!(config_dir(env(&[("HOME", "/home/me")]), false), Some(PathBuf::from("/home/me/.config/dbt-lens")));
    }

    #[test]
    fn config_dir_ignores_empty_and_relative_values() {
        assert_eq!(config_dir(env(&[("XDG_CONFIG_HOME", ""), ("HOME", "/home/me")]), false), Some(PathBuf::from("/home/me/.config/dbt-lens")));
        assert_eq!(config_dir(env(&[("XDG_CONFIG_HOME", "relative/dir")]), false), None);
        assert_eq!(config_dir(env(&[]), false), None);
    }

    #[test]
    fn config_dir_on_windows_uses_appdata_and_never_home() {
        let dir = config_dir(env(&[("APPDATA", r"C:\Users\me\AppData\Roaming"), ("HOME", "/c/Users/me")]), true).unwrap();
        let text = dir.to_string_lossy();
        assert!(text.starts_with(r"C:\Users\me\AppData\Roaming") && text.ends_with("dbt-lens"), "{text}");
        let fallback = config_dir(env(&[("USERPROFILE", r"C:\Users\me"), ("HOME", "/c/Users/me")]), true).unwrap();
        assert!(fallback.to_string_lossy().starts_with(r"C:\Users\me"));
        assert_eq!(config_dir(env(&[("HOME", "/c/Users/me")]), true), None);
    }

    #[test]
    fn normalise_collapses_windows_spellings_of_one_path() {
        let a = normalise(r"\\?\C:\Work\Shop\", true);
        let b = normalise(r"c:/work/shop", true);
        assert_eq!(a, b);
        assert_eq!(normalise(r"\\?\UNC\server\share\shop", true), "//server/share/shop");
    }

    #[test]
    fn normalise_keeps_case_on_unix() {
        assert_eq!(normalise("/Users/me/Shop/", false), "/Users/me/Shop");
        assert_ne!(normalise("/Users/me/Shop", false), normalise("/users/me/shop", false));
    }

    #[test]
    fn file_name_is_readable_and_distinct_per_path() {
        let one = file_name("/a/my project", false);
        let two = file_name("/b/my project", false);
        assert!(one.starts_with("my_project-") && one.ends_with(".json"), "{one}");
        assert_ne!(one, two);
    }

    #[tokio::test]
    async fn update_round_trips_and_rejects_another_projects_file() {
        let dir = std::env::temp_dir().join(format!("dbt-lens-settings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store { path: Some(dir.join("p.json")), project: "/work/shop".into(), lock: Default::default() };

        let saved = store
            .update(|s| {
                s.selected = Some(".env.uat".into());
                s.envs.insert(".env.uat".into(), EnvOverride { name: Some("Acceptance".into()), hidden: None });
            })
            .await
            .unwrap();
        assert_eq!(saved.selected.as_deref(), Some(".env.uat"));
        let loaded = store.load();
        assert_eq!(loaded.envs[".env.uat"].name.as_deref(), Some("Acceptance"));

        let other = Store { path: Some(dir.join("p.json")), project: "/work/other".into(), lock: Default::default() };
        assert!(other.load().envs.is_empty(), "a file written for another project must not apply");

        std::fs::write(dir.join("p.json"), b"{ not json").unwrap();
        assert!(store.load().envs.is_empty(), "corrupt settings fall back to defaults");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
