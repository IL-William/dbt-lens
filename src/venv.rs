//! Which Python environment is in play, for the status bar.
//!
//! Reports the one this process was launched with, and otherwise the ones
//! sitting in the project, so the answer is never a bare "none" when there is
//! something obvious to activate.

use std::path::{Path, PathBuf};

#[derive(serde::Serialize, Default, Clone)]
pub struct VenvInfo {
    /// "activated" when $VIRTUAL_ENV was set, "project" when merely found on disk.
    pub source: String,
    pub name: String,
    pub path: String,
    pub python: String,
    pub dbt: String,
    /// Other environments found next to the project, none of them active.
    pub others: Vec<String>,
}

fn bin(venv: &Path, exe: &str) -> PathBuf {
    if cfg!(windows) {
        venv.join("Scripts").join(format!("{exe}.exe"))
    } else {
        venv.join("bin").join(exe)
    }
}

fn first_line(venv: &Path, exe: &str, args: &[&str]) -> String {
    let path = bin(venv, exe);
    if !path.exists() {
        return String::new();
    }
    std::process::Command::new(path)
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .ok()
        .map(|o| {
            let text = if o.stdout.is_empty() { o.stderr } else { o.stdout };
            String::from_utf8_lossy(&text).lines().next().unwrap_or("").trim().to_string()
        })
        .unwrap_or_default()
}

/// The interpreter inside a virtual environment.
pub fn python_in(venv: &Path) -> PathBuf {
    bin(venv, "python")
}

/// Whether the Snowflake connector is installed, looked up on disk so that
/// nothing has to be started to find out.
pub fn has_snowflake_connector(venv: &Path) -> bool {
    let installed = |site: PathBuf| site.join("snowflake").join("connector").is_dir();
    // Windows: Lib\site-packages. Elsewhere: lib/pythonX.Y/site-packages.
    installed(venv.join("Lib").join("site-packages"))
        || std::fs::read_dir(venv.join("lib"))
            .map(|entries| entries.flatten().any(|e| installed(e.path().join("site-packages"))))
            .unwrap_or(false)
}

fn is_venv(p: &Path) -> bool {
    p.join("pyvenv.cfg").exists() || bin(p, "python").exists()
}

pub fn detect(root: &Path) -> VenvInfo {
    let mut info = VenvInfo::default();

    let mut found: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() && is_venv(&p) {
                found.push(p);
            }
        }
    }
    // A bare venv with no dbt in it is the least useful answer, so rank those last.
    found.sort_by_key(|p| (!bin(p, "dbt").exists(), p.clone()));

    let active = std::env::var("VIRTUAL_ENV").ok().map(PathBuf::from).filter(|p| p.exists());
    let chosen = match &active {
        Some(p) => Some(p.clone()),
        None => found.first().cloned(),
    };

    let Some(venv) = chosen else {
        return info;
    };
    info.source = if active.is_some() { "activated".into() } else { "project".into() };
    info.name = venv.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    info.path = venv.display().to_string();
    info.python = first_line(&venv, "python", &["--version"]).replace("Python ", "");
    info.dbt = first_line(&venv, "dbt", &["--version"]);
    info.others = found
        .iter()
        .filter(|p| **p != venv)
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .collect();
    info
}
