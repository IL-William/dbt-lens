//! Compiled SQL lookup and freshness.
//!
//! The Fusion manifest carries no `compiled_path`, so the location is derived
//! from dbt's layout and probed. Every candidate tried is reported, which makes
//! a wrong guess obvious instead of silent.

use std::path::{Path, PathBuf};

/// Compiled output is considered aged after this, per the UI's own rule.
const STALE_AFTER: u64 = 3600;

#[derive(serde::Serialize, Default)]
pub struct CompiledInfo {
    pub found: bool,
    pub path: String,
    /// Paths probed, shown when nothing was found.
    pub candidates: Vec<String>,
    pub compiled_at: u64,
    pub age_secs: u64,
    pub source_at: u64,
    pub stale: bool,
    pub reasons: Vec<String>,
    pub content: String,
    pub truncated: bool,
    pub bytes: u64,
}

fn mtime(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Where dbt would have written the compiled SQL for this node.
fn candidates(root: &Path, target: &Path, package: &str, file: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for dir in ["compiled", "run"] {
        if !package.is_empty() {
            out.push(target.join(dir).join(package).join(file));
        }
        out.push(target.join(dir).join(file));
    }
    let _ = root;
    out
}

pub fn look_up(
    root: &Path,
    target: &Path,
    package: &str,
    file: &str,
    yml: &str,
    max_bytes: u64,
) -> CompiledInfo {
    let mut info = CompiledInfo::default();
    let tried = candidates(root, target, package, file);
    let hit = tried.iter().find(|p| p.is_file());

    let Some(path) = hit else {
        info.candidates = tried.iter().map(|p| p.display().to_string()).collect();
        return info;
    };

    info.found = true;
    info.path = path.display().to_string();
    info.compiled_at = mtime(path);
    info.bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    info.age_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().saturating_sub(info.compiled_at))
        .unwrap_or(0);

    let source_at = mtime(&root.join(file));
    let yml_at = if yml.is_empty() { 0 } else { mtime(&root.join(yml)) };
    info.source_at = source_at.max(yml_at);

    if source_at > info.compiled_at {
        info.reasons.push("the model file changed after this was compiled".into());
    }
    if yml_at > info.compiled_at {
        info.reasons.push("the schema file changed after this was compiled".into());
    }
    if info.age_secs > STALE_AFTER {
        info.reasons.push(format!("compiled {} ago", human(info.age_secs)));
    }
    info.stale = !info.reasons.is_empty();

    match std::fs::read(path) {
        Ok(bytes) => {
            info.truncated = bytes.len() as u64 > max_bytes;
            let slice = &bytes[..bytes.len().min(max_bytes as usize)];
            info.content = String::from_utf8_lossy(slice).into_owned();
        }
        Err(e) => info.reasons.push(format!("cannot read it: {e}")),
    }
    info
}

pub fn human(secs: u64) -> String {
    match secs {
        0..=59 => format!("{secs}s"),
        60..=3599 => format!("{}min", secs / 60),
        3600..=86399 => format!("{}h{:02}", secs / 3600, (secs % 3600) / 60),
        _ => format!("{}d", secs / 86400),
    }
}
