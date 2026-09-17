//! Terminal backend: a real PTY per WebSocket connection.
//!
//! `portable-pty` gives a ConPTY on Windows and a Unix98 PTY elsewhere, so the
//! same code drives zsh on macOS and Git Bash on the VM.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct ShellSpec {
    pub program: String,
    pub args: Vec<String>,
}

impl ShellSpec {
    /// Resolves the shell to spawn: an explicit `--shell` wins, then Git Bash on
    /// Windows / `$SHELL` elsewhere, then a platform fallback.
    pub fn detect(explicit: Option<String>) -> ShellSpec {
        if let Some(spec) = explicit.as_deref().and_then(parse_shell) {
            return spec;
        }
        #[cfg(windows)]
        {
            if let Some(bash) = find_git_bash() {
                return ShellSpec { program: bash.display().to_string(), args: vec!["-i".into()] };
            }
            return ShellSpec { program: "powershell.exe".into(), args: vec!["-NoLogo".into()] };
        }
        #[cfg(not(windows))]
        {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            ShellSpec { program: shell, args: vec!["-l".into()] }
        }
    }
}

/// Splits a `--shell` value into a program and its arguments.
///
/// Splitting on whitespace alone cannot express the usual Windows shell,
/// `C:\Program Files\Git\bin\bash.exe`. So a quoted program is honoured, and
/// an unquoted value naming an existing file is taken whole instead of split.
fn parse_shell(line: &str) -> Option<ShellSpec> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    if let Some(rest) = line.strip_prefix('"') {
        let (program, args) = rest.split_once('"').unwrap_or((rest, ""));
        return Some(ShellSpec {
            program: program.to_string(),
            args: args.split_whitespace().map(str::to_string).collect(),
        });
    }
    if Path::new(line).is_file() {
        return Some(ShellSpec { program: line.to_string(), args: Vec::new() });
    }
    let mut parts = line.split_whitespace().map(str::to_string);
    Some(ShellSpec { program: parts.next()?, args: parts.collect() })
}

#[cfg(windows)]
fn find_git_bash() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Ok(base) = std::env::var(var) {
            candidates.push(Path::new(&base).join("Git").join("bin").join("bash.exe"));
            candidates.push(Path::new(&base).join("Programs").join("Git").join("bin").join("bash.exe"));
        }
    }
    candidates.into_iter().find(|p| p.exists())
}

#[cfg(not(windows))]
#[allow(dead_code)]
fn find_git_bash() -> Option<PathBuf> {
    let _ = Path::new("");
    None
}

pub enum FromPty {
    Output(Vec<u8>),
    Exited,
}

pub struct PtySession {
    master: Box<dyn portable_pty::MasterPty + Send>,
    input: std::sync::mpsc::Sender<Vec<u8>>,
    child: std::sync::Arc<std::sync::Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
}

impl PtySession {
    pub fn spawn(
        shell: &ShellSpec,
        cwd: &Path,
        cols: u16,
        rows: u16,
        out: tokio::sync::mpsc::Sender<FromPty>,
    ) -> anyhow::Result<PtySession> {
        let pty = portable_pty::native_pty_system();
        let pair = pty.openpty(portable_pty::PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;

        let mut cmd = portable_pty::CommandBuilder::new(&shell.program);
        for arg in &shell.args {
            cmd.arg(arg);
        }
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("DBT_LENS", "1");

        let child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave); // so the reader sees EOF when the shell exits

        let mut reader = pair.master.try_clone_reader()?;
        let out_reader = out.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if out_reader.blocking_send(FromPty::Output(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = out_reader.blocking_send(FromPty::Exited);
        });

        let mut writer = pair.master.take_writer()?;
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            while let Ok(chunk) = rx.recv() {
                if writer.write_all(&chunk).is_err() || writer.flush().is_err() {
                    break;
                }
            }
        });

        Ok(PtySession {
            master: pair.master,
            input: tx,
            child: std::sync::Arc::new(std::sync::Mutex::new(child)),
        })
    }

    pub fn write(&self, data: Vec<u8>) {
        let _ = self.input.send(data);
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let _ = self
            .master
            .resize(portable_pty::PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }

    pub fn kill(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(line: &str) -> Option<(String, Vec<String>)> {
        parse_shell(line).map(|s| (s.program, s.args))
    }

    #[test]
    fn a_shell_and_its_flags_are_split() {
        assert_eq!(spec("zsh -l"), Some(("zsh".into(), vec!["-l".into()])));
        assert_eq!(spec("bash"), Some(("bash".into(), vec![])));
    }

    #[test]
    fn a_quoted_program_may_contain_spaces() {
        // The shape a Windows user needs: the Git Bash path holds a space.
        assert_eq!(
            spec(r#""C:\Program Files\Git\bin\bash.exe" -i"#),
            Some((r"C:\Program Files\Git\bin\bash.exe".into(), vec!["-i".into()])),
        );
        assert_eq!(
            spec(r#""C:\Program Files\Git\bin\bash.exe""#),
            Some((r"C:\Program Files\Git\bin\bash.exe".into(), vec![])),
        );
        // An unterminated quote still yields the path rather than nothing.
        assert_eq!(spec(r#""/opt/my shell"#), Some(("/opt/my shell".into(), vec![])));
    }

    #[test]
    fn an_unquoted_path_that_exists_is_not_split() {
        let dir = std::env::temp_dir().join(format!("dbt-lens-pty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("my shell");
        std::fs::write(&path, "#!/bin/sh\n").unwrap();

        let line = path.display().to_string();
        assert_eq!(spec(&line), Some((line.clone(), vec![])));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn nothing_usable_falls_back_to_detection() {
        assert!(parse_shell("").is_none());
        assert!(parse_shell("   ").is_none());
    }
}
