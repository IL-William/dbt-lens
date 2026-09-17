//! Working-tree status and the handful of git commands the UI can run.
//!
//! Two rules hold everywhere in this file:
//!   - nothing here destroys work. No `-f`, no `--hard`, no `clean`, no
//!     `push --force`. The worst any button can do is create a stash.
//!   - nothing here can hang the server. Network commands run with terminal
//!     prompts disabled and ssh in batch mode, and every command has a deadline.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(serde::Serialize, Clone, Default)]
pub struct FileChange {
    pub path: String,
    /// The two-letter porcelain code, index status then worktree status.
    pub code: String,
}

#[derive(serde::Serialize, Clone, Default)]
pub struct GitInfo {
    pub repo: bool,
    pub branch: String,
    pub upstream: String,
    pub ahead: u32,
    pub behind: u32,
    /// A merge is in progress, so a commit would conclude it.
    pub merging: bool,
    /// Tracked paths that differ from HEAD, and untracked ones. An entry ending
    /// in `/` stands for a whole directory, which is how git reports collapsed
    /// results. Both feed the explorer colours.
    pub modified: Vec<String>,
    pub untracked: Vec<String>,
    pub staged: Vec<FileChange>,
    pub unstaged: Vec<FileChange>,
    pub conflicted: Vec<String>,
}

#[derive(serde::Serialize, Clone, Default)]
pub struct GitRun {
    pub ok: bool,
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    /// Set when a checkout was refused because it would overwrite local work.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub blocking: Vec<String>,
}

const NET_ENV: &[(&str, &str)] = &[
    ("GIT_TERMINAL_PROMPT", "0"),
    // Fail fast instead of waiting on a passphrase prompt nobody can answer.
    // The host alias from ~/.ssh/config still resolves normally.
    ("GIT_SSH_COMMAND", "ssh -o BatchMode=yes"),
];

/// Runs git with a deadline, draining both pipes so a chatty hook cannot deadlock.
pub fn run(root: &Path, args: &[&str], env: &[(&str, &str)], timeout: Duration) -> GitRun {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(root).args(args);
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return GitRun { ok: false, code: -1, stdout: String::new(), stderr: format!("cannot run git: {e}"), blocking: Vec::new() }
        }
    };

    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let err_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = err_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(30));
            }
            Err(_) => break None,
        }
    };

    let stdout = String::from_utf8_lossy(&out_thread.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&err_thread.join().unwrap_or_default()).into_owned();
    match status {
        Some(s) => GitRun { ok: s.success(), code: s.code().unwrap_or(-1), stdout, stderr, blocking: Vec::new() },
        None => GitRun {
            ok: false,
            code: -1,
            stdout,
            stderr: format!("git took longer than {}s and was stopped", timeout.as_secs()),
            blocking: Vec::new(),
        },
    }
}

fn read(root: &Path, args: &[&str]) -> Option<String> {
    let r = run(root, args, &[], Duration::from_secs(20));
    r.ok.then_some(r.stdout)
}

// ---------------------------------------------------------------- status ----

pub fn status(root: &Path) -> GitInfo {
    let mut info = GitInfo::default();

    // --show-prefix alone: anything touching HEAD fails in a repository with no
    // commit yet, and such a repository still has a status worth showing.
    let Some(prefix) = read(root, &["rev-parse", "--show-prefix"]) else {
        return info;
    };
    info.repo = true;
    let prefix = prefix.trim().to_string();
    info.branch = read(root, &["branch", "--show-current"]).unwrap_or_default().trim().to_string();
    info.upstream = read(root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .unwrap_or_default()
        .trim()
        .to_string();
    if !info.upstream.is_empty() {
        if let Some(counts) = read(root, &["rev-list", "--left-right", "--count", "@{u}...HEAD"]) {
            let mut it = counts.split_whitespace();
            info.behind = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
            info.ahead = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        }
    }
    info.merging = read(root, &["rev-parse", "--git-dir"])
        .map(|d| Path::new(root).join(d.trim()).join("MERGE_HEAD").exists())
        .unwrap_or(false);

    // --no-renames keeps every entry to a single record, so there is no paired
    // "old path" entry to track while parsing.
    let raw = run(root, &["status", "--porcelain=v1", "-z", "--no-renames"], &[], Duration::from_secs(30));
    if !raw.ok {
        return info;
    }

    for entry in raw.stdout.split('\0') {
        if entry.len() < 4 {
            continue;
        }
        let (code, path) = entry.split_at(3);
        let path = match path.strip_prefix(prefix.as_str()) {
            Some(p) if !prefix.is_empty() => p.to_string(),
            _ if prefix.is_empty() => path.to_string(),
            _ => continue, // outside the opened project
        };
        if path.is_empty() {
            continue;
        }
        let code = code[..2].to_string();
        let (x, y) = (code.as_bytes()[0], code.as_bytes()[1]);

        if code == "??" {
            info.untracked.push(path);
            continue;
        }
        info.modified.push(path.clone());

        // Both sides "unmerged" in any combination means a conflict.
        let conflict = matches!(code.as_str(), "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU");
        if conflict {
            info.conflicted.push(path);
            continue;
        }
        if x != b' ' {
            info.staged.push(FileChange { path: path.clone(), code: code.clone() });
        }
        if y != b' ' {
            info.unstaged.push(FileChange { path, code });
        }
    }
    info.modified.sort();
    info.untracked.sort();
    info.staged.sort_by(|a, b| a.path.cmp(&b.path));
    info.unstaged.sort_by(|a, b| a.path.cmp(&b.path));
    info.conflicted.sort();
    info
}

// -------------------------------------------------------------- branches ----

#[derive(serde::Serialize, Clone)]
pub struct Branch {
    pub name: String,
    pub current: bool,
    pub upstream: String,
    pub when: String,
}

/// Local branches, most recently committed first. Long-lived repositories carry
/// hundreds, so the UI filters rather than lists.
pub fn branches(root: &Path) -> Vec<Branch> {
    let current = read(root, &["branch", "--show-current"]).unwrap_or_default().trim().to_string();
    let Some(out) = read(
        root,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:short)\t%(upstream:short)\t%(committerdate:relative)",
            "refs/heads",
        ],
    ) else {
        return Vec::new();
    };
    out.lines()
        .filter_map(|l| {
            let mut f = l.split('\t');
            let name = f.next()?.to_string();
            if name.is_empty() {
                return None;
            }
            Some(Branch {
                current: name == current,
                upstream: f.next().unwrap_or("").to_string(),
                when: f.next().unwrap_or("").to_string(),
                name,
            })
        })
        .collect()
}

// --------------------------------------------------------------- actions ----

/// Switches branch. Never forces: if git refuses because local work is in the
/// way, the blocking paths come back so the UI can offer to stash them.
pub fn checkout(root: &Path, branch: &str, stash_first: bool) -> GitRun {
    if stash_first {
        let from = read(root, &["branch", "--show-current"]).unwrap_or_default().trim().to_string();
        let label = format!("dbt-lens: switching away from {}", if from.is_empty() { "detached HEAD" } else { &from });
        let stashed = run(
            root,
            &["stash", "push", "--include-untracked", "-m", &label],
            &[],
            Duration::from_secs(60),
        );
        if !stashed.ok {
            return stashed;
        }
    }
    let mut r = run(root, &["checkout", branch], &[], Duration::from_secs(60));
    if !r.ok {
        r.blocking = parse_blocking(&r.stderr);
    }
    r
}

/// Pulls the file list out of git's "your local changes would be overwritten" refusal.
fn parse_blocking(stderr: &str) -> Vec<String> {
    let mut files = Vec::new();
    let mut collecting = false;
    for line in stderr.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("error:") || trimmed.starts_with("Your local changes") {
            collecting = true;
            continue;
        }
        if trimmed.starts_with("Please commit") || trimmed.starts_with("Aborting") || trimmed.is_empty() {
            collecting = false;
            continue;
        }
        if collecting && !trimmed.contains(' ') {
            files.push(trimmed.to_string());
        }
    }
    files
}

pub fn stage(root: &Path, paths: &[String]) -> GitRun {
    let mut args = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    run(root, &args, &[], Duration::from_secs(60))
}

pub fn unstage(root: &Path, paths: &[String]) -> GitRun {
    let mut args = vec!["restore", "--staged", "--"];
    args.extend(paths.iter().map(String::as_str));
    run(root, &args, &[], Duration::from_secs(60))
}

/// Fetches first, as asked, so the ahead/behind shown next to the commit is
/// current. A failing fetch never blocks the commit: offline still commits.
pub fn commit(root: &Path, message: &str) -> (GitRun, Option<String>) {
    let fetched = run(root, &["fetch", "--quiet"], NET_ENV, Duration::from_secs(120));
    let fetch_note = (!fetched.ok).then(|| {
        let line = fetched.stderr.lines().next().unwrap_or("fetch failed").trim().to_string();
        format!("fetch failed, committed anyway: {line}")
    });
    // Hooks run: a project may have several, and silently bypassing them with
    // --no-verify would be a nasty surprise. They can be slow, hence 5 minutes.
    let r = run(root, &["commit", "-m", message], &[], Duration::from_secs(300));
    (r, fetch_note)
}

pub fn push(root: &Path) -> GitRun {
    let branch = read(root, &["branch", "--show-current"]).unwrap_or_default().trim().to_string();
    if branch.is_empty() {
        return GitRun { ok: false, code: -1, stdout: String::new(), stderr: "detached HEAD, nothing to push".into(), blocking: Vec::new() };
    }
    // --set-upstream is safe and makes the first push of a topic branch work.
    run(root, &["push", "--set-upstream", "origin", &branch], NET_ENV, Duration::from_secs(180))
}

/// --ff-only: a pull must never start a merge behind your back. If the branches
/// have diverged it stops and says so, and you decide what to do.
pub fn pull(root: &Path) -> GitRun {
    run(root, &["pull", "--ff-only"], NET_ENV, Duration::from_secs(180))
}

pub fn fetch(root: &Path) -> GitRun {
    run(root, &["fetch", "--prune"], NET_ENV, Duration::from_secs(120))
}

/// The commits a push would send.
pub fn outgoing(root: &Path) -> Vec<String> {
    read(root, &["log", "--oneline", "--no-decorate", "@{u}..HEAD"])
        .map(|o| o.lines().map(str::to_string).collect())
        .unwrap_or_default()
}

#[derive(serde::Serialize, Default)]
pub struct DiffView {
    pub path: String,
    /// The committed version, empty when the file is new.
    pub before: String,
    /// What is on disk now, empty when the file was deleted.
    pub after: String,
    pub before_missing: bool,
    pub after_missing: bool,
    pub binary: bool,
    pub truncated: bool,
}

/// HEAD against the working tree, which is what "see my changes" means. The
/// `HEAD:./path` form lets git resolve the path relative to the project, so a
/// project sitting below the repository root needs no special handling.
/// `on_disk` is the same path already confined to the project by the caller.
pub fn diff(root: &Path, rel: &str, on_disk: &Path, max_bytes: usize) -> DiffView {
    let mut view = DiffView { path: rel.to_string(), ..Default::default() };

    let show = run(root, &["show", &format!("HEAD:./{rel}")], &[], Duration::from_secs(30));
    if show.ok {
        view.before = show.stdout;
    } else {
        view.before_missing = true;
    }

    match std::fs::read(on_disk) {
        Ok(bytes) => {
            view.binary = bytes.contains(&0);
            view.after = String::from_utf8_lossy(&bytes).into_owned();
        }
        Err(_) => view.after_missing = true,
    }
    view.binary = view.binary || view.before.as_bytes().contains(&0);

    if view.before.len() > max_bytes || view.after.len() > max_bytes {
        view.truncated = true;
        view.before.truncate(max_bytes);
        view.after.truncate(max_bytes);
    }
    view
}

pub fn merge_abort(root: &Path) -> GitRun {
    run(root, &["merge", "--abort"], &[], Duration::from_secs(60))
}
