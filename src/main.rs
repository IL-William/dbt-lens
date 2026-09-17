//! dbt-lens: a small browser IDE for dbt projects.
//! Editor + terminal + lineage, served from one self-contained binary.

mod api;
mod collin;
mod compiled;
mod envs;
mod files;
mod git;
mod graph;
mod manifest;
mod pty;
mod settings;
mod venv;

use clap::Parser;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Parser)]
#[command(name = "dbt-lens", version, about = "Editor, terminal and dbt lineage in the browser")]
struct Args {
    /// dbt project root
    #[arg(default_value = ".")]
    project: PathBuf,

    /// Port to listen on (the next free port is used if this one is taken)
    #[arg(short, long, default_value_t = 4321)]
    port: u16,

    /// Path to manifest.json (default: <project>/target/manifest.json)
    #[arg(long)]
    manifest: Option<PathBuf>,

    /// Path to catalog.json (default: <project>/target/catalog.json)
    #[arg(long)]
    catalog: Option<PathBuf>,

    /// Path to the column lineage cache (default: <project>/target/column_lineage.json)
    #[arg(long)]
    column_lineage: Option<PathBuf>,

    /// Shell for the integrated terminal (default: $SHELL, or Git Bash on Windows)
    #[arg(long)]
    shell: Option<String>,

    /// Do not open a browser window on startup
    #[arg(long)]
    no_open: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let root = args
        .project
        .canonicalize()
        .map_err(|e| anyhow::anyhow!("cannot open {}: {e}", args.project.display()))?;
    if !files::is_dbt_project(&root) {
        eprintln!("  no dbt_project.yml in {} - point dbt-lens at the dbt project root", root.display());
    }
    let manifest_path = args.manifest.unwrap_or_else(|| root.join("target").join("manifest.json"));
    let catalog_path = args.catalog.unwrap_or_else(|| root.join("target").join("catalog.json"));
    let cll_path = args
        .column_lineage
        .unwrap_or_else(|| root.join("target").join("column_lineage.json"));

    let graph = if manifest_path.exists() {
        eprintln!("  reading {}", manifest_path.display());
        let (path, cat, cll) = (manifest_path.clone(), catalog_path.clone(), cll_path.clone());
        let g = tokio::task::spawn_blocking(move || api::load_graph(&path, &cat, &cll)).await??;
        let c = &g.meta.counts;
        eprintln!(
            "  {} nodes in {} ms  ({} models, {} sources, {} tests)",
            g.nodes.len(),
            g.meta.load_ms,
            c.get("model").unwrap_or(&0),
            c.get("source").unwrap_or(&0),
            c.get("test").unwrap_or(&0),
        );
        if g.meta.catalog_columns > 0 {
            eprintln!("  catalog.json merged ({} columns typed)", g.meta.catalog_columns);
        } else {
            eprintln!("  no catalog.json - column types stay as declared in YAML (run dbt compile --write-catalog)");
        }
        g
    } else {
        eprintln!("  no manifest at {} - lineage stays empty until dbt writes one", manifest_path.display());
        graph::Graph::build(Default::default(), &manifest_path, 0, 0)
    };

    let target_dir = manifest_path.parent().map(Path::to_path_buf).unwrap_or_else(|| root.join("target"));
    let venv = venv::detect(&root);
    let shell = pty::ShellSpec::detect(args.shell);
    // Bound before the state exists: the guard in api.rs compares Host and
    // Origin against the port actually taken, which may not be the one asked for.
    let listener = bind(args.port).await?;
    let url = format!("http://{}", listener.local_addr()?);
    let state = Arc::new(api::AppState {
        port: listener.local_addr()?.port(),
        root: root.clone(),
        manifest_path,
        catalog_path,
        cll_path,
        target_dir,
        venv: venv.clone(),
        file_index: tokio::sync::RwLock::new(Arc::new(files::scan(&root))),
        settings: settings::Store::new(&root),
        graph: tokio::sync::RwLock::new(Arc::new(graph)),
        git: tokio::sync::Mutex::new(None),
        shell: shell.clone(),
    });

    tokio::spawn(api::watch_artifacts(state.clone()));
    tokio::spawn(api::watch_files(state.clone()));

    eprintln!("\n  dbt-lens  {}", env!("CARGO_PKG_VERSION"));
    eprintln!("  project   {}", root.display());
    eprintln!("  shell     {} {}", shell.program, shell.args.join(" "));
    if !venv.name.is_empty() {
        eprintln!(
            "  venv      {} ({}{})",
            venv.name,
            if venv.source == "activated" { "activated" } else { "found in project, not activated" },
            if venv.python.is_empty() { String::new() } else { format!(", python {}", venv.python) },
        );
    }
    eprintln!("  open      {url}\n");

    if !args.no_open {
        open_browser(&url);
    }

    axum::serve(listener, api::router(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            eprintln!("\n  bye");
        })
        .await?;
    Ok(())
}

/// Binds to localhost only, walking forward if the port is already in use.
async fn bind(port: u16) -> anyhow::Result<tokio::net::TcpListener> {
    for candidate in port..port.saturating_add(20) {
        match tokio::net::TcpListener::bind(("127.0.0.1", candidate)).await {
            Ok(l) => return Ok(l),
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(e) => return Err(e.into()),
        }
    }
    anyhow::bail!("no free port in {}..{}", port, port.saturating_add(20))
}

fn open_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(url);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", url]);
        c
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(url);
        c
    };
    let _ = cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn();
}
