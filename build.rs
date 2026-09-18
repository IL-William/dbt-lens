//! Stamps the binary with the build it came from.
//!
//! The version in `Cargo.toml` only moves at a release, so between two tags it
//! cannot tell two builds apart. That is exactly the question asked after
//! reinstalling on the Windows VM, so `git describe` goes in as well, and a
//! build date for a source tree copied without its `.git`.
//!
//! Everything is composed here: `DBT_LENS_BUILD` is the one string the rest of
//! the program reads, and it is never empty.

use std::path::Path;
use std::process::Command;

fn main() {
    let mut parts = Vec::new();
    if let Some(described) = git_describe() {
        parts.push(described);
    }
    parts.push(format!("built {}", build_date()));
    println!("cargo:rustc-env=DBT_LENS_BUILD={}", parts.join(", "));

    println!("cargo:rerun-if-changed=build.rs");
    // Only when there is a .git to watch: cargo treats a missing path as
    // changed, which would rebuild the crate on every single invocation.
    //
    // The consequence of watching anything at all is that a local `cargo build`
    // after editing only `src/` keeps the previous stamp, since none of these
    // moved. `cargo install`, which is how the VM updates, builds in a fresh
    // target directory every time and so always restamps.
    if Path::new(".git").is_dir() {
        println!("cargo:rerun-if-changed=.git/HEAD");
        println!("cargo:rerun-if-changed=.git/refs");
    }
}

/// The nearest tag, how far past it, the short commit, and whether the tree was
/// dirty. None when there is no `.git`, or no git on PATH, which is not an
/// error: the date alone still answers "is this the binary I just built".
fn git_describe() -> Option<String> {
    let out = Command::new("git").args(["describe", "--tags", "--always", "--dirty"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// UTC, to the day. A stamp is for telling two builds apart, not for timing one.
fn build_date() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Days since the epoch to a calendar date, by Howard Hinnant's algorithm. Here
/// rather than from a crate, for one line of output (0003).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}
