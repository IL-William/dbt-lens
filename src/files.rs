//! Filesystem access, confined to the opened project directory.

use std::path::{Path, PathBuf};

const IGNORED: &[&str] = &[".git", ".DS_Store", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"];
/// Skipped by the file index only: the tree still browses them, but they are
/// generated or vendored and would drown a search. `target` alone holds more
/// files than the whole project.
const NOT_INDEXED: &[&str] = &["target", "logs", ".git", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".cortex"];
const MAX_INDEXED: usize = 60_000;
const MAX_READ_BYTES: u64 = 4 * 1024 * 1024;

/// Turns a project-relative path into an absolute one, refusing anything that
/// would escape the project root (`..`, absolute paths, symlinks pointing out).
pub fn resolve(root: &Path, rel: &str) -> anyhow::Result<PathBuf> {
    let mut out = root.to_path_buf();
    for seg in rel.replace('\\', "/").split('/') {
        match seg {
            "" | "." => continue,
            ".." => anyhow::bail!("path escapes the project root"),
            // A drive letter: on Windows `push` would replace the root with it.
            s if s.ends_with(':') => anyhow::bail!("path escapes the project root"),
            s => out.push(s),
        }
    }
    // A path that does not exist yet (a new file, or a deleted one being
    // diffed) is judged by its nearest existing ancestor.
    let mut probe = out.as_path();
    while !probe.exists() {
        probe = probe.parent().unwrap_or(root);
    }
    let canon_root = root.canonicalize()?;
    let canon = probe.canonicalize()?;
    if !canon.starts_with(&canon_root) {
        anyhow::bail!("path escapes the project root");
    }
    Ok(out)
}

#[derive(serde::Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    pub size: u64,
}

pub fn list_dir(root: &Path, rel: &str) -> anyhow::Result<Vec<Entry>> {
    let dir = resolve(root, rel)?;
    let prefix = rel.trim_matches('/');
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if IGNORED.contains(&name.as_str()) {
            continue;
        }
        let meta = entry.metadata()?;
        out.push(Entry {
            path: if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") },
            name,
            dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
        });
    }
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[derive(serde::Serialize)]
pub struct FileBody {
    pub path: String,
    pub content: String,
    pub size: u64,
    pub truncated: bool,
}

pub fn read_file(root: &Path, rel: &str) -> anyhow::Result<FileBody> {
    let path = resolve(root, rel)?;
    let size = std::fs::metadata(&path)?.len();
    let bytes = if size > MAX_READ_BYTES {
        use std::io::Read;
        let mut buf = vec![0u8; MAX_READ_BYTES as usize];
        let mut f = std::fs::File::open(&path)?;
        let n = f.read(&mut buf)?;
        buf.truncate(n);
        buf
    } else {
        std::fs::read(&path)?
    };
    if bytes.contains(&0) {
        anyhow::bail!("binary file");
    }
    Ok(FileBody {
        path: rel.to_string(),
        content: String::from_utf8_lossy(&bytes).into_owned(),
        size,
        truncated: size > MAX_READ_BYTES,
    })
}

/// Flat list of project-relative file paths, for the search palette.
/// Virtualenvs are skipped wholesale: they hold thousands of vendored files and
/// nobody searches for one by name.
pub fn scan(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = stack.pop() {
        if out.len() >= MAX_INDEXED {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            // Dotfiles stay in: .env, .sqlfluff and .github are all things
            // people open. Only the generated directories are skipped.
            if NOT_INDEXED.contains(&name.as_str()) || name == ".DS_Store" {
                continue;
            }
            let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                if path.join("pyvenv.cfg").exists() {
                    continue; // a virtualenv
                }
                stack.push((path, rel));
            } else if meta.is_file() {
                out.push(rel);
            }
        }
    }
    out.sort();
    out
}

/// Ranked substring search over the index. Deliberately not fuzzy: with paths
/// this long, a subsequence match returns everything and ranks nothing.
pub fn search_paths<'a>(paths: &'a [String], query: &str, limit: usize) -> Vec<&'a str> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return paths.iter().take(limit).map(String::as_str).collect();
    }
    let mut hits: Vec<(u32, usize, &str)> = Vec::new();
    for p in paths {
        let lower = p.to_lowercase();
        let base = lower.rsplit('/').next().unwrap_or(&lower);
        let score = if base == q {
            0
        } else if base.starts_with(&q) {
            10
        } else if base.contains(&q) {
            20
        } else if lower.contains(&q) {
            30
        } else {
            continue;
        };
        // Vendored packages rank below the project's own files.
        let vendored = lower.starts_with("dbt_packages/") as u32 * 100;
        hits.push((score + vendored, p.len(), p.as_str()));
    }
    hits.sort_unstable();
    hits.truncate(limit);
    hits.into_iter().map(|(_, _, p)| p).collect()
}

pub fn write_file(root: &Path, rel: &str, content: &str) -> anyhow::Result<()> {
    let path = resolve(root, rel)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content)?;
    Ok(())
}

/// Whether this directory looks like the root of a dbt project. Used only to
/// warn at startup: dbt-lens opens whatever it is given, since a monorepo or a
/// manifest passed with `--manifest` is a legitimate way to work.
pub fn is_dbt_project(root: &Path) -> bool {
    root.join("dbt_project.yml").is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dbt_project_is_recognised_by_its_project_file() {
        let dir = std::env::temp_dir().join(format!("dbt-lens-files-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!is_dbt_project(&dir), "an empty directory is not a dbt project");

        // A directory of that name is not the project file.
        std::fs::create_dir_all(dir.join("dbt_project.yml")).unwrap();
        assert!(!is_dbt_project(&dir));
        std::fs::remove_dir_all(dir.join("dbt_project.yml")).unwrap();

        std::fs::write(dir.join("dbt_project.yml"), "name: demo\n").unwrap();
        assert!(is_dbt_project(&dir));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn resolve_confines_every_shape_of_path_to_the_root() {
        let dir = std::env::temp_dir().join(format!("dbt-lens-resolve-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("models")).unwrap();
        std::fs::write(dir.join("models").join("a.sql"), "select 1").unwrap();
        let root = dir.canonicalize().unwrap();

        assert!(resolve(&root, "models/a.sql").is_ok());
        assert!(resolve(&root, "models\\a.sql").is_ok());
        // Not there yet, nor its directory: judged by the nearest existing ancestor.
        assert!(resolve(&root, "models/new/deeper/b.sql").is_ok());

        assert!(resolve(&root, "../x").is_err());
        assert!(resolve(&root, "..\\..\\x").is_err());
        assert!(resolve(&root, "models/../../x").is_err());
        assert!(resolve(&root, "/etc/passwd").map(|p| p.starts_with(&root)).unwrap_or(true));
        assert!(resolve(&root, "C:/x").is_err());
        assert!(resolve(&root, "C:\\Users\\me").is_err());

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/", dir.join("escape")).unwrap();
            assert!(resolve(&root, "escape/etc/passwd").is_err());
        }

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
