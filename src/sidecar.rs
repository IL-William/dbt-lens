//! The Snowflake script, `tools/sf_lineage.py serve`, started and stopped here.
//!
//! The binary never talks to a warehouse. It starts the script only once the
//! user has switched Snowflake lineage on, and the script connects on its first
//! request, so a sign-in tab can only ever follow a click (0016).
//!
//! Two rules hold everywhere in this file:
//!   - nothing here can hang the server. Every wait has a deadline, and
//!     switching off interrupts a request still waiting on Snowflake.
//!   - nothing the script writes to stderr is logged. Single sign-on can print
//!     a login link there, so the last lines stay in memory, for the UI only.

use crate::collin::RelEdge;
use crate::venv::{self, VenvInfo};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Notify};

/// Embedded, so a binary copied on its own still carries the script it speaks to.
const SCRIPT: &str = include_str!("../tools/sf_lineage.py");

const TAIL_LINES: usize = 20;

#[derive(Clone, Copy)]
pub struct Deadlines {
    /// Python, its imports and the profile: all local, but slow on a cold VM.
    pub ready: Duration,
    /// The first answer of a session may wait on a sign-in in the browser.
    pub first: Duration,
    pub later: Duration,
    /// How long the script gets to quit on its own before it is killed.
    pub quit: Duration,
}

impl Default for Deadlines {
    fn default() -> Self {
        Deadlines {
            ready: Duration::from_secs(60),
            first: Duration::from_secs(180),
            later: Duration::from_secs(60),
            quit: Duration::from_secs(2),
        }
    }
}

#[derive(serde::Serialize, Clone, Debug, Default, PartialEq)]
pub struct Status {
    /// off, starting, ready, busy or failed.
    pub state: &'static str,
    /// What was started, so the user can see which Python runs with their profile.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub python: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub profile: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub target: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub role: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub authenticator: String,
    /// The profiles.yml the script read, announced before it read it, so it is
    /// known even when reading it is what failed. Kept when the script stops.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub profiles: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub error: String,
    /// The script's last stderr lines, kept only after a failure.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub log: Vec<String>,
}

/// Why a query failed, and whose fault it points at: a connection Snowflake
/// refused is about the profile, a query it rejected is about the object or
/// the role, and a request this build got wrong is neither.
#[derive(Debug, Clone, PartialEq)]
pub struct QueryError {
    pub message: String,
    pub phase: String,
}

impl QueryError {
    fn own(message: impl Into<String>) -> QueryError {
        QueryError { message: message.into(), phase: String::new() }
    }
}

impl std::fmt::Display for QueryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// A program that can run the script, with the arguments that go before it.
#[derive(Clone, Debug, PartialEq)]
pub struct Interpreter {
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// Where to look for Python, best first: a virtual environment of the project
/// that has the Snowflake connector, then the one the status bar reports, whose
/// error says what is missing, then the PATH.
pub fn interpreters(root: &Path, env: &VenvInfo) -> Vec<Interpreter> {
    let chosen = (!env.path.is_empty()).then(|| PathBuf::from(&env.path));
    let envs: Vec<PathBuf> = chosen.iter().cloned().chain(env.others.iter().map(|name| root.join(name))).collect();
    let mut dirs: Vec<PathBuf> = envs.iter().filter(|e| venv::has_snowflake_connector(e)).cloned().collect();
    dirs.extend(chosen.filter(|e| !dirs.contains(e)));

    let mut out: Vec<Interpreter> = dirs
        .iter()
        .map(|dir| Interpreter { program: venv::python_in(dir), args: Vec::new() })
        .filter(|i| i.program.exists())
        .collect();
    let on_path: &[(&str, &[&str])] = if cfg!(windows) {
        &[("python", &[]), ("py", &["-3"])]
    } else {
        &[("python3", &[]), ("python", &[])]
    };
    out.extend(on_path.iter().map(|(program, args)| Interpreter {
        program: PathBuf::from(program),
        args: args.iter().map(|a| a.to_string()).collect(),
    }));
    out
}

/// Writes the embedded script under the configuration directory, named by its
/// hash: two versions of dbt-lens never overwrite each other's copy, and the
/// file is written only when it is missing or different.
pub fn install_script(config_dir: &Path) -> Result<PathBuf, String> {
    let name = format!("sf_lineage-{:016x}.py", crate::settings::fnv1a64(SCRIPT.as_bytes()));
    let path = config_dir.join("sidecar").join(name);
    if std::fs::read(&path).map_or(true, |bytes| bytes != SCRIPT.as_bytes()) {
        crate::settings::write_atomic(&path, SCRIPT.as_bytes()).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    }
    Ok(path)
}

struct Running {
    child: Child,
    stdin: Option<ChildStdin>,
    replies: mpsc::Receiver<serde_json::Value>,
    tail: Arc<Mutex<VecDeque<String>>>,
    stderr_reader: Option<JoinHandle<()>>,
    cancel: Arc<Notify>,
    next_id: u64,
    /// A request has succeeded, so the session is signed in and the shorter
    /// deadline applies.
    signed_in: bool,
}

enum Waited {
    Answer(serde_json::Value),
    Gone,
    Late,
    Cancelled,
}

pub struct Sidecar {
    enabled: AtomicBool,
    running: tokio::sync::Mutex<Option<Running>>,
    status: Mutex<Status>,
    /// The profile the script named. Outlives the script, so the file stays
    /// reachable while the switch is off, which is when it gets corrected.
    profiles: Mutex<Option<PathBuf>>,
    /// What the last start used. A restart repeats it rather than working it
    /// out again, so it cannot quietly pick another interpreter.
    launch: Mutex<Option<(Vec<Interpreter>, PathBuf, PathBuf)>>,
    /// The running script's cancel signal, reachable without the lock that a
    /// request waiting on Snowflake holds.
    cancel: Mutex<Option<Arc<Notify>>>,
    deadlines: Deadlines,
}

impl Sidecar {
    pub fn new(enabled: bool, deadlines: Deadlines) -> Sidecar {
        Sidecar {
            enabled: AtomicBool::new(enabled),
            running: tokio::sync::Mutex::new(None),
            status: Mutex::new(Status { state: "off", ..Default::default() }),
            profiles: Mutex::new(None),
            launch: Mutex::new(None),
            cancel: Mutex::new(None),
            deadlines,
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::SeqCst);
    }

    pub fn status(&self) -> Status {
        self.status.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// Ready or answering: a request can be sent without starting anything.
    pub fn is_up(&self) -> bool {
        matches!(self.status().state, "ready" | "busy")
    }

    /// The profile the script named, if it ever did.
    pub fn profile_path(&self) -> Option<PathBuf> {
        self.profiles.lock().ok().and_then(|p| p.clone())
    }

    fn set_status(&self, mut status: Status) -> Status {
        // Carried by every status, whatever the script is doing now.
        if let Some(path) = self.profile_path() {
            status.profiles = path.display().to_string();
        }
        if let Ok(mut s) = self.status.lock() {
            *s = status.clone();
        }
        status
    }

    fn set_state(&self, state: &'static str) {
        if let Ok(mut s) = self.status.lock() {
            s.state = state;
        }
    }

    fn fail(&self, python: String, error: String, log: Vec<String>) -> Status {
        self.set_status(Status { state: "failed", python, error, log, ..Default::default() })
    }

    /// Installs the script and starts it with the best interpreter there is.
    pub async fn start_for(&self, root: &Path, env: &VenvInfo) -> Status {
        let Some(dir) = crate::settings::config_dir(|key| std::env::var_os(key), cfg!(windows)) else {
            let error = "no configuration directory to install the Snowflake script in: set DBT_LENS_CONFIG_DIR";
            return self.fail(String::new(), error.into(), Vec::new());
        };
        let script = match tokio::task::spawn_blocking(move || install_script(&dir)).await {
            Ok(Ok(path)) => path,
            Ok(Err(e)) => return self.fail(String::new(), e, Vec::new()),
            Err(e) => return self.fail(String::new(), e.to_string(), Vec::new()),
        };
        self.start(&interpreters(root, env), &script, root).await
    }

    /// Stops and starts again, on what the last start used. The script reads
    /// the profile once, so this is what a corrected profile needs.
    pub async fn restart(&self, root: &Path, env: &VenvInfo) -> Status {
        self.stop().await;
        let last = self.launch.lock().ok().and_then(|l| l.clone());
        match last {
            Some((candidates, script, cwd)) => self.start(&candidates, &script, &cwd).await,
            None => self.start_for(root, env).await,
        }
    }

    /// Starts the script unless it is running. The script checks everything
    /// that needs no network before it says it is ready, so a broken setup
    /// shows up here rather than on a click.
    pub async fn start(&self, candidates: &[Interpreter], script: &Path, cwd: &Path) -> Status {
        let mut slot = self.running.lock().await;
        if slot.is_some() {
            return self.status();
        }
        if let Ok(mut last) = self.launch.lock() {
            *last = Some((candidates.to_vec(), script.to_path_buf(), cwd.to_path_buf()));
        }
        self.set_status(Status { state: "starting", ..Default::default() });

        let mut error = String::from("no Python found: create the project's virtual environment, or put python on the PATH");
        let mut spawned = None;
        for candidate in candidates {
            let mut cmd = Command::new(&candidate.program);
            cmd.args(&candidate.args)
                .arg("-u")
                .arg(script)
                .arg("serve")
                .current_dir(cwd)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            match cmd.spawn() {
                Ok(child) => {
                    spawned = Some((candidate, child));
                    break;
                }
                Err(e) => error = format!("cannot run {}: {e}", candidate.program.display()),
            }
        }
        let Some((candidate, mut child)) = spawned else {
            return self.fail(String::new(), error, Vec::new());
        };
        let python = std::iter::once(candidate.program.display().to_string())
            .chain(candidate.args.iter().cloned())
            .collect::<Vec<_>>()
            .join(" ");

        let (tx, replies) = mpsc::channel(64);
        if let Some(stdout) = child.stdout.take() {
            std::thread::spawn(move || {
                each_line(stdout, |line| {
                    // One JSON object per line is the protocol. Anything else is
                    // a library talking, and is dropped.
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                        if value.is_object() {
                            let _ = tx.blocking_send(value);
                        }
                    }
                });
            });
        }
        let tail = Arc::new(Mutex::new(VecDeque::new()));
        let stderr_reader = child.stderr.take().map(|stderr| {
            let tail = tail.clone();
            std::thread::spawn(move || {
                each_line(stderr, |line| {
                    if let Ok(mut t) = tail.lock() {
                        if t.len() == TAIL_LINES {
                            t.pop_front();
                        }
                        t.push_back(line.chars().take(300).collect());
                    }
                });
            })
        });
        let mut run = Running {
            stdin: child.stdin.take(),
            child,
            replies,
            tail,
            stderr_reader,
            cancel: Arc::new(Notify::new()),
            next_id: 0,
            signed_in: false,
        };

        let ready = tokio::time::timeout(self.deadlines.ready, async {
            while let Some(value) = run.replies.recv().await {
                match value.get("event").and_then(|e| e.as_str()) {
                    // Announced before the file is read, so a profile that
                    // cannot be read is still a profile that can be opened.
                    Some("profiles") => {
                        if let (Ok(mut held), Some(path)) = (self.profiles.lock(), value.get("path").and_then(|p| p.as_str())) {
                            *held = Some(PathBuf::from(path));
                        }
                    }
                    Some("ready") => return Some(value),
                    _ => {}
                }
            }
            None
        })
        .await;
        match ready {
            Ok(Some(value)) if self.enabled() => {
                let text = |key: &str| value.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string();
                if let Ok(mut cancel) = self.cancel.lock() {
                    *cancel = Some(run.cancel.clone());
                }
                *slot = Some(run);
                self.set_status(Status {
                    state: "ready",
                    python,
                    profile: text("profile"),
                    target: text("target"),
                    role: text("role"),
                    authenticator: text("authenticator"),
                    ..Default::default()
                })
            }
            // Switched off while starting: nothing may stay running.
            Ok(Some(_)) => {
                self.shut(run).await;
                self.set_status(Status { state: "off", ..Default::default() })
            }
            Ok(None) => {
                let log = self.shut(run).await;
                let error = explain(&log).unwrap_or_else(|| "the Snowflake script stopped before it was ready".into());
                self.fail(python, error, log)
            }
            Err(_) => {
                let log = self.shut(run).await;
                let error = format!("the Snowflake script was not ready within {} s", self.deadlines.ready.as_secs());
                self.fail(python, error, log)
            }
        }
    }

    /// Column pairs around one column, in one direction. Requests go one at a
    /// time, because the script holds a single connection.
    pub async fn query(&self, relation: &str, column: &str, direction: &str, depth: u32) -> Result<Vec<RelEdge>, QueryError> {
        let mut slot = self.running.lock().await;
        let Some(run) = slot.as_mut() else {
            return Err(QueryError::own("the Snowflake script is not running"));
        };
        run.next_id += 1;
        let id = run.next_id;
        let request = serde_json::json!({
            "id": id,
            "relation": relation,
            "column": column,
            "direction": direction,
            "depth": depth,
        });
        let sent = run
            .stdin
            .as_mut()
            .is_some_and(|stdin| writeln!(stdin, "{request}").and_then(|()| stdin.flush()).is_ok());
        let within = if run.signed_in { self.deadlines.later } else { self.deadlines.first };
        let cancel = run.cancel.clone();

        let waited = if sent {
            self.set_state("busy");
            tokio::select! {
                reply = next_reply(&mut run.replies, id) => reply.map_or(Waited::Gone, Waited::Answer),
                () = tokio::time::sleep(within) => Waited::Late,
                () = cancel.notified() => Waited::Cancelled,
            }
        } else {
            Waited::Gone
        };

        match waited {
            Waited::Answer(reply) => {
                self.set_state("ready");
                if let Some(error) = reply.get("error").and_then(|e| e.as_str()) {
                    let phase = reply.get("phase").and_then(|p| p.as_str()).unwrap_or_default();
                    return Err(QueryError { message: error.to_string(), phase: phase.to_string() });
                }
                run.signed_in = true;
                let rows = reply.get("rows").cloned().unwrap_or_else(|| serde_json::json!([]));
                serde_json::from_value(rows)
                    .map_err(|e| QueryError::own(format!("the Snowflake script sent a reply this build cannot read: {e}")))
            }
            Waited::Cancelled => {
                if let Some(run) = slot.take() {
                    self.shut(run).await;
                }
                Err(QueryError::own("Snowflake lineage was switched off"))
            }
            Waited::Gone | Waited::Late => {
                let late = matches!(waited, Waited::Late);
                let Some(run) = slot.take() else {
                    return Err(QueryError::own("the Snowflake script is not running"));
                };
                if let Ok(mut c) = self.cancel.lock() {
                    *c = None;
                }
                let log = self.shut(run).await;
                let error = if late {
                    format!("Snowflake did not answer within {} s, so the script was stopped. The next click starts it again.", within.as_secs())
                } else {
                    explain(&log).unwrap_or_else(|| "the Snowflake script stopped".into())
                };
                let python = self.status().python;
                self.fail(python, error.clone(), log);
                Err(QueryError::own(error))
            }
        }
    }

    /// Stops the script, interrupting a request that is still waiting.
    pub async fn stop(&self) -> Status {
        if let Some(cancel) = self.cancel.lock().ok().and_then(|mut c| c.take()) {
            // Kept as a permit when nothing waits yet, so a request that has
            // not reached its wait still sees it.
            cancel.notify_one();
        }
        let running = self.running.lock().await.take();
        if let Some(run) = running {
            self.shut(run).await;
        }
        self.set_status(Status { state: "off", ..Default::default() })
    }

    async fn shut(&self, run: Running) -> Vec<String> {
        let grace = self.deadlines.quit;
        tokio::task::spawn_blocking(move || shutdown(run, grace)).await.unwrap_or_default()
    }
}

async fn next_reply(replies: &mut mpsc::Receiver<serde_json::Value>, id: u64) -> Option<serde_json::Value> {
    while let Some(value) = replies.recv().await {
        if value.get("id").and_then(|v| v.as_u64()) == Some(id) {
            return Some(value);
        }
    }
    None
}

/// Lines from a pipe, decoded leniently. Reading must never stop early: a pipe
/// nobody drains fills up, and the script then blocks on its next write.
fn each_line(pipe: impl Read, mut f: impl FnMut(String)) {
    let mut reader = BufReader::new(pipe);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => f(String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']).to_string()),
        }
    }
}

/// Asks the script to quit and closes its stdin, then kills it if it is still
/// there after `grace`. Closing stdin comes first because on Windows the
/// python.exe of a virtual environment is a launcher: killing it leaves the
/// interpreter it started running, while the end of stdin stops that one too.
fn shutdown(mut run: Running, grace: Duration) -> Vec<String> {
    if let Some(mut stdin) = run.stdin.take() {
        let _ = stdin.write_all(b"{\"op\":\"quit\"}\n");
    }
    let deadline = Instant::now() + grace;
    loop {
        match run.child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) | Err(_) => {
                let _ = run.child.kill();
                let _ = run.child.wait();
                break;
            }
        }
    }
    // The last lines can still be in the pipe. Waited for briefly, never for
    // long: an interpreter the launcher started can keep the pipe open.
    if let Some(reader) = run.stderr_reader.take() {
        let until = Instant::now() + Duration::from_millis(500);
        while !reader.is_finished() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    run.tail.lock().map(|t| t.iter().cloned().collect()).unwrap_or_default()
}

/// The script's own message when it gave one, otherwise its last line, which
/// after a crash is the exception.
fn explain(log: &[String]) -> Option<String> {
    log.iter()
        .rev()
        .find_map(|line| line.strip_prefix("sf_lineage: ").map(str::to_string))
        .or_else(|| log.iter().rev().find(|line| !line.trim().is_empty()).cloned())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn quick() -> Deadlines {
        Deadlines {
            ready: Duration::from_secs(5),
            first: Duration::from_millis(1500),
            later: Duration::from_millis(1500),
            quit: Duration::from_millis(300),
        }
    }

    /// A stand-in for the Python script, run as `sh -u fake.sh serve`: to sh,
    /// the `-u` meant for Python only makes unset variables an error. It
    /// records its pid next to itself.
    fn fake(tag: &str, body: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("dbt-lens-sidecar-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake.sh");
        std::fs::write(&script, format!("echo \"$$\" > \"$(dirname \"$0\")/pid\"\n{body}")).unwrap();
        (dir, script)
    }

    /// The first candidate does not exist, so starting also proves the fallback.
    fn sh() -> Vec<Interpreter> {
        vec![
            Interpreter { program: "/nonexistent/python3".into(), args: Vec::new() },
            Interpreter { program: "/bin/sh".into(), args: Vec::new() },
        ]
    }

    const READY: &str = r#"echo 'Initiating login request with your identity provider.'
echo '{"event":"ready","profile":"shop","target":"dev","role":"transformer","authenticator":"externalbrowser"}'
"#;

    fn gone(dir: &Path) -> bool {
        let pid = std::fs::read_to_string(dir.join("pid")).unwrap();
        let alive = Command::new("kill").args(["-0", pid.trim()]).stderr(Stdio::null()).status().unwrap().success();
        !alive
    }

    #[tokio::test]
    async fn replies_are_matched_by_id_and_noise_is_dropped() {
        let body = format!(
            r#"{READY}while IFS= read -r line; do
  case "$line" in
    *'"id":1,'*) echo 'progress: 50%'; echo '{{"id":9,"rows":[]}}'; echo '{{"id":1,"rows":[{{"from_rel":"RAW.CRM.CUSTOMERS","from_col":"id","to_rel":"ANALYTICS.STAGING.STG_CUSTOMERS","to_col":"customer_id","kind":"view","distance":1}}]}}' ;;
    *'"id":2,'*) echo 'sf_lineage: not for this request' >&2; echo '{{"id":2,"error":"Object does not exist"}}' ;;
    *'"op":"quit"'*) exit 0 ;;
  esac
done
"#
        );
        let (dir, script) = fake("replies", &body);
        let car = Sidecar::new(true, quick());

        let status = car.start(&sh(), &script, &dir).await;
        assert_eq!(status.state, "ready", "{status:?}");
        assert_eq!((status.profile.as_str(), status.target.as_str(), status.role.as_str()), ("shop", "dev", "transformer"));
        assert_eq!(status.python, "/bin/sh");
        assert!(car.is_up());

        let rows = car.query("ANALYTICS.STAGING.STG_CUSTOMERS", "customer_id", "UPSTREAM", 2).await.unwrap();
        assert_eq!(
            rows,
            [RelEdge {
                from_rel: "RAW.CRM.CUSTOMERS".into(),
                from_col: "id".into(),
                to_rel: "ANALYTICS.STAGING.STG_CUSTOMERS".into(),
                to_col: "customer_id".into(),
                kind: "view".into(),
            }]
        );
        assert_eq!(car.query("X.Y.Z", "c", "UPSTREAM", 1).await.unwrap_err().message, "Object does not exist");
        assert_eq!(car.status().state, "ready", "an error reply leaves the script running");

        assert_eq!(car.stop().await.state, "off");
        assert!(gone(&dir));
        assert!(car.query("X.Y.Z", "c", "UPSTREAM", 1).await.is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_script_that_stops_before_ready_says_why() {
        let (dir, script) = fake(
            "dies",
            "echo 'Traceback (most recent call last):' >&2\necho 'sf_lineage: snowflake-connector-python is not installed in this interpreter' >&2\nexit 2\n",
        );
        let car = Sidecar::new(true, quick());
        let status = car.start(&sh(), &script, &dir).await;
        assert_eq!(status.state, "failed");
        assert_eq!(status.error, "snowflake-connector-python is not installed in this interpreter");
        assert!(status.log.iter().any(|l| l.starts_with("Traceback")), "{:?}", status.log);
        assert!(!car.is_up());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn nothing_to_run_is_a_failure_that_names_the_program() {
        let car = Sidecar::new(true, quick());
        let missing = [Interpreter { program: "/nonexistent/python3".into(), args: Vec::new() }];
        let status = car.start(&missing, Path::new("/nonexistent/script.py"), &std::env::temp_dir()).await;
        assert_eq!(status.state, "failed");
        assert!(status.error.starts_with("cannot run /nonexistent/python3"), "{}", status.error);
        assert!(car.start(&[], Path::new("x.py"), &std::env::temp_dir()).await.error.starts_with("no Python found"));
    }

    #[tokio::test]
    async fn a_silent_snowflake_is_given_up_on_at_the_deadline() {
        let (dir, script) = fake("silent", &format!("{READY}while IFS= read -r line; do :; done\n"));
        let car = Sidecar::new(true, quick());
        assert_eq!(car.start(&sh(), &script, &dir).await.state, "ready");

        let started = Instant::now();
        let error = car.query("X.Y.Z", "c", "UPSTREAM", 1).await.unwrap_err();
        assert!(started.elapsed() >= Duration::from_millis(1400), "{:?}", started.elapsed());
        assert!(error.message.starts_with("Snowflake did not answer within 1 s"), "{error}");
        let status = car.status();
        assert_eq!((status.state, status.python.as_str()), ("failed", "/bin/sh"));
        assert!(gone(&dir));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn switching_off_interrupts_a_request_that_is_still_waiting() {
        let (dir, script) = fake("cancel", &format!("{READY}while IFS= read -r line; do :; done\n"));
        let slow = Deadlines { first: Duration::from_secs(30), ..quick() };
        let car = Arc::new(Sidecar::new(true, slow));
        assert_eq!(car.start(&sh(), &script, &dir).await.state, "ready");

        let asking = tokio::spawn({
            let car = car.clone();
            async move { car.query("X.Y.Z", "c", "UPSTREAM", 1).await }
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        let started = Instant::now();
        assert_eq!(car.stop().await.state, "off");
        let answer = tokio::time::timeout(Duration::from_secs(5), asking).await.expect("the request must return").unwrap();
        assert_eq!(answer.unwrap_err().message, "Snowflake lineage was switched off");
        assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
        assert!(gone(&dir));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_script_that_ignores_quit_is_killed() {
        let (dir, script) = fake("stubborn", &format!("{READY}trap '' TERM\nwhile :; do sleep 0.1; done\n"));
        let car = Sidecar::new(true, quick());
        assert_eq!(car.start(&sh(), &script, &dir).await.state, "ready");
        let started = Instant::now();
        car.stop().await;
        assert!(started.elapsed() >= Duration::from_millis(300), "{:?}", started.elapsed());
        assert!(gone(&dir));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_start_that_ends_after_switching_off_leaves_nothing_running() {
        let (dir, script) = fake("late", &format!("{READY}while IFS= read -r line; do :; done\n"));
        let car = Sidecar::new(false, quick());
        assert_eq!(car.start(&sh(), &script, &dir).await.state, "off");
        assert!(gone(&dir));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn the_profile_is_named_before_ready_and_outlives_the_script() {
        let body = format!(
            r#"echo '{{"event":"profiles","path":"/tmp/named/profiles.yml"}}'
{READY}asked=0
while IFS= read -r line; do
  case "$line" in
    *'"op":"quit"'*) exit 0 ;;
  esac
  asked=$((asked + 1))
  if [ "$asked" = 1 ]; then
    echo '{{"id":1,"error":"251005: User is empty","phase":"connect"}}'
  else
    echo '{{"id":2,"error":"Object does not exist","phase":"query"}}'
  fi
done
"#
        );
        let (dir, script) = fake("named", &body);
        let car = Sidecar::new(true, quick());

        let status = car.start(&sh(), &script, &dir).await;
        assert_eq!((status.state, status.profiles.as_str()), ("ready", "/tmp/named/profiles.yml"));

        // The phase is what says whether the profile is to blame.
        let refused = car.query("X.Y.Z", "c", "UPSTREAM", 1).await.unwrap_err();
        assert_eq!((refused.message.as_str(), refused.phase.as_str()), ("251005: User is empty", "connect"));
        let rejected = car.query("X.Y.Z", "c", "UPSTREAM", 1).await.unwrap_err();
        assert_eq!(rejected.phase, "query");

        // Switched off, the file stays reachable: off is when it gets corrected.
        assert_eq!(car.stop().await.profiles, "/tmp/named/profiles.yml");
        assert_eq!(car.profile_path(), Some(PathBuf::from("/tmp/named/profiles.yml")));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_restart_repeats_the_last_start() {
        let (dir, script) = fake("restart", &format!("{READY}while IFS= read -r line; do :; done\n"));
        let car = Sidecar::new(true, quick());
        assert_eq!(car.start(&sh(), &script, &dir).await.state, "ready");
        let first = std::fs::read_to_string(dir.join("pid")).unwrap();

        // A root that holds nothing: working the interpreter out again would
        // fail, so a ready script proves the recorded start was repeated.
        let status = car.restart(Path::new("/nonexistent"), &VenvInfo::default()).await;
        assert_eq!(status.state, "ready", "{status:?}");
        assert_ne!(std::fs::read_to_string(dir.join("pid")).unwrap(), first, "a restart starts another process");

        car.stop().await;
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_venv_with_the_connector_comes_first_then_the_status_bar_one_then_the_path() {
        let root = std::env::temp_dir().join(format!("dbt-lens-sidecar-venvs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for name in ["plain-env", "sf-env", "other-env"] {
            std::fs::create_dir_all(root.join(name).join("bin")).unwrap();
            std::fs::write(root.join(name).join("bin").join("python"), "").unwrap();
        }
        std::fs::create_dir_all(root.join("sf-env/lib/python3.12/site-packages/snowflake/connector")).unwrap();
        let env = VenvInfo {
            path: root.join("plain-env").display().to_string(),
            others: vec!["sf-env".into(), "other-env".into()],
            ..Default::default()
        };
        let programs: Vec<String> = interpreters(&root, &env).iter().map(|i| i.program.display().to_string()).collect();
        assert_eq!(
            programs,
            [
                root.join("sf-env/bin/python").display().to_string(),
                root.join("plain-env/bin/python").display().to_string(),
                "python3".to_string(),
                "python".to_string(),
            ]
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_script_is_installed_once_per_version() {
        let dir = std::env::temp_dir().join(format!("dbt-lens-sidecar-install-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = install_script(&dir).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), SCRIPT);
        std::fs::write(&path, "tampered").unwrap();
        assert_eq!(install_script(&dir).unwrap(), path);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), SCRIPT, "a different copy is replaced");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_explanation_prefers_the_scripts_own_words() {
        let log = |lines: &[&str]| lines.iter().map(|l| l.to_string()).collect::<Vec<_>>();
        assert_eq!(explain(&log(&["sf_lineage: no profiles.yml at x", "later noise"])).as_deref(), Some("no profiles.yml at x"));
        assert_eq!(explain(&log(&["Traceback", "TypeError: bad", ""])).as_deref(), Some("TypeError: bad"));
        assert_eq!(explain(&[]), None);
    }
}
