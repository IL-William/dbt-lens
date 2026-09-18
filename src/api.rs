//! HTTP + WebSocket surface. Everything the browser UI talks to lives here.

use crate::collin::{self, RawColLineage};
use crate::compiled;
use crate::envs;
use crate::files;
use crate::git::{self, GitInfo};
use crate::graph::{ColRef, Graph, Kind, Place};
use crate::manifest::{RawCatalog, RawManifest};
use crate::pty::{FromPty, PtySession, ShellSpec};
use crate::sidecar;
use crate::venv::VenvInfo;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{header, Method, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

pub struct AppState {
    /// The port actually bound. Host and Origin are checked against it.
    pub port: u16,
    pub root: PathBuf,
    pub manifest_path: PathBuf,
    pub catalog_path: PathBuf,
    pub cll_path: PathBuf,
    /// Where dbt writes its artifacts; the compiled SQL lives under it.
    pub target_dir: PathBuf,
    pub venv: VenvInfo,
    pub file_index: RwLock<Arc<Vec<String>>>,
    pub settings: crate::settings::Store,
    pub graph: RwLock<Arc<Graph>>,
    pub shell: ShellSpec,
    pub git: tokio::sync::Mutex<Option<(std::time::Instant, GitInfo)>>,
    /// The Snowflake script, running only while the user has it switched on (0016).
    pub sidecar: sidecar::Sidecar,
    /// Held while the column-lineage cache is merged and written, and while the
    /// watcher reloads: a click's edges must land in the graph that stays.
    pub cll_lock: tokio::sync::Mutex<()>,
    /// Modification times of manifest, catalog and cache already acted on. A
    /// click records the cache it wrote, or the watcher would re-read the whole
    /// manifest for it three seconds later.
    pub seen: std::sync::Mutex<[u64; 3]>,
}

#[derive(rust_embed::RustEmbed)]
#[folder = "web/"]
struct Assets;

pub fn mtime_secs(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn load_graph(manifest_path: &Path, catalog_path: &Path, cll_path: &Path) -> anyhow::Result<Graph> {
    let started = std::time::Instant::now();
    let mtime = mtime_secs(manifest_path);
    let raw = RawManifest::load(manifest_path)?;
    let mut graph = Graph::build(raw, manifest_path, mtime, started.elapsed().as_millis());
    if catalog_path.exists() {
        match RawCatalog::load(catalog_path) {
            Ok(cat) => {
                let n = graph.merge_catalog(cat, mtime_secs(catalog_path));
                graph.meta.catalog_columns = n;
                graph.meta.catalog_mtime = graph.catalog_mtime;
            }
            Err(e) => eprintln!("  catalog.json ignored: {e}"),
        }
    }
    // After merge_catalog, never before: both re-sort Node.columns and the column
    // slots recorded by the lineage merge are positions in that final order.
    if cll_path.exists() {
        match RawColLineage::load(cll_path) {
            Ok(raw) => {
                let n = graph.merge_col_lineage(raw, mtime_secs(cll_path));
                graph.meta.cll_file = cll_path.display().to_string();
                eprintln!("  column lineage merged ({n} edges)");
            }
            Err(e) => eprintln!("  column lineage ignored: {e}"),
        }
    }
    graph.meta.load_ms = started.elapsed().as_millis();
    Ok(graph)
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/meta", get(meta))
        .route("/api/search", get(search))
        .route("/api/node", get(node))
        .route("/api/envs", get(list_envs).put(save_envs))
        .route("/api/envs/select", post(select_env))
        .route("/api/compiled", get(compiled_sql))
        .route("/api/lineage", get(lineage))
        .route("/api/collineage", get(col_lineage))
        .route("/api/collineage/fetch", post(fetch_col_lineage))
        .route("/api/sidecar", get(sidecar_status).post(sidecar_switch))
        .route("/api/profiles", get(read_profile).put(write_profile))
        .route("/api/dir", get(dir))
        .route("/api/files", get(file_search))
        .route("/api/file", get(read_file).put(write_file))
        .route("/api/resolve", post(resolve))
        .route("/api/git", get(git_status))
        .route("/api/git/branches", get(git_branches))
        .route("/api/git/diff", get(git_diff))
        .route("/api/git/outgoing", get(git_outgoing))
        .route("/api/git/checkout", post(git_checkout))
        .route("/api/git/stage", post(git_stage))
        .route("/api/git/unstage", post(git_unstage))
        .route("/api/git/commit", post(git_commit))
        .route("/api/git/push", post(git_push))
        .route("/api/git/pull", post(git_pull))
        .route("/api/git/fetch", post(git_fetch))
        .route("/api/git/merge-abort", post(git_merge_abort))
        .route("/api/reload", post(reload))
        .route("/ws/pty", get(ws_pty))
        .fallback(static_asset)
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

// ----------------------------------------------------------------- guard ----
//
// Binding to 127.0.0.1 keeps other machines out, not other web pages. A page
// from any site can open a WebSocket to localhost, can POST here without a
// preflight, and, through DNS rebinding, can become same-origin with this
// server. So every request states where it comes from, and this checks (0015).

/// `Host` must name this server exactly: a rebound domain never does.
fn host_allowed(host: Option<&str>, port: u16) -> bool {
    match host {
        Some(h) => h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"),
        None => false,
    }
}

/// `Origin` must be this server's own page. Browsers always send it on a
/// WebSocket handshake and on cross-site requests; a missing one is a local
/// tool such as curl, accepted unless `required`.
fn origin_allowed(origin: Option<&str>, port: u16, required: bool) -> bool {
    match origin {
        Some(o) => o == format!("http://127.0.0.1:{port}") || o == format!("http://localhost:{port}"),
        None => !required,
    }
}

fn header_str<'a>(req: &'a axum::extract::Request, name: header::HeaderName) -> Option<&'a str> {
    req.headers().get(name).and_then(|v| v.to_str().ok())
}

/// Carried by every reply. The page loads nothing from anywhere else, so the
/// policy says exactly that, and `frame-ancestors` keeps the terminal out of
/// an invisible frame on someone else's site. `unsafe-inline` for styles is
/// xterm.js, which injects a stylesheet of its own at runtime.
const HEADERS: &[(&str, &str)] = &[
    (
        "content-security-policy",
        concat!(
            "default-src 'none'; ",
            "script-src 'self'; ",
            "style-src 'self' 'unsafe-inline'; ",
            "img-src 'self' data:; ",
            "connect-src 'self' ws://127.0.0.1:* ws://localhost:*; ",
            "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        ),
    ),
    ("x-content-type-options", "nosniff"),
    ("referrer-policy", "no-referrer"),
];

async fn guard(State(st): State<Arc<AppState>>, req: axum::extract::Request, next: Next) -> Response {
    let refused = || (StatusCode::FORBIDDEN, "refused: not from this server's own page").into_response();
    if !host_allowed(header_str(&req, header::HOST), st.port) {
        return refused();
    }
    let upgrade = header_str(&req, header::UPGRADE).is_some_and(|u| u.eq_ignore_ascii_case("websocket"));
    let reads_only = matches!(*req.method(), Method::GET | Method::HEAD) && !upgrade;
    if !reads_only && !origin_allowed(header_str(&req, header::ORIGIN), st.port, upgrade) {
        return refused();
    }
    let mut res = next.run(req).await;
    let headers = res.headers_mut();
    for (name, value) in HEADERS {
        headers.insert(
            header::HeaderName::from_static(name),
            header::HeaderValue::from_static(value),
        );
    }
    res
}

// ---------------------------------------------------------------- static ----

async fn static_asset(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    match Assets::get(path) {
        Some(file) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            ([(header::CONTENT_TYPE, mime.as_ref())], file.data).into_response()
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

// ------------------------------------------------------------------- api ----

fn err(e: impl std::fmt::Display) -> Response {
    (StatusCode::BAD_REQUEST, e.to_string()).into_response()
}

#[derive(serde::Serialize)]
struct MetaBody {
    root: String,
    shell: String,
    venv: VenvInfo,
    meta: crate::graph::Meta,
}

async fn meta(State(st): State<Arc<AppState>>) -> Response {
    let graph = st.graph.read().await.clone();
    Json(MetaBody {
        root: st.root.display().to_string(),
        shell: format!("{} {}", st.shell.program, st.shell.args.join(" ")).trim().to_string(),
        venv: st.venv.clone(),
        meta: graph.meta.clone(),
    })
    .into_response()
}

async fn reload(State(st): State<Arc<AppState>>) -> Response {
    let _cache = st.cll_lock.lock().await;
    let (path, cat, cll) = (st.manifest_path.clone(), st.catalog_path.clone(), st.cll_path.clone());
    match tokio::task::spawn_blocking(move || load_graph(&path, &cat, &cll)).await {
        Ok(Ok(g)) => {
            let meta = g.meta.clone();
            *st.graph.write().await = Arc::new(g);
            Json(meta).into_response()
        }
        Ok(Err(e)) => err(e),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
struct SearchQuery {
    #[serde(default)]
    q: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(serde::Serialize)]
struct Hit<'a> {
    id: &'a str,
    name: &'a str,
    kind: Kind,
    file: &'a str,
    schema: &'a str,
    materialized: &'a str,
    tests: usize,
    disabled: bool,
}

fn parse_kinds(spec: &str) -> Vec<Kind> {
    spec.split(',')
        .filter(|s| !s.is_empty())
        .filter_map(|s| match s {
            "model" => Some(Kind::Model),
            "source" => Some(Kind::Source),
            "seed" => Some(Kind::Seed),
            "snapshot" => Some(Kind::Snapshot),
            "test" => Some(Kind::Test),
            "exposure" => Some(Kind::Exposure),
            _ => None,
        })
        .collect()
}

async fn search(State(st): State<Arc<AppState>>, Query(q): Query<SearchQuery>) -> Response {
    let graph = st.graph.read().await.clone();
    let kinds = parse_kinds(&q.kind);
    let hits = graph.search(&q.q, &kinds, q.limit.unwrap_or(200).min(2000));
    let body: Vec<Hit> = hits
        .iter()
        .map(|&i| {
            let n = &graph.nodes[i as usize];
            Hit {
                id: &n.id,
                name: &n.name,
                kind: n.kind,
                file: &n.file,
                schema: &n.schema,
                materialized: &n.materialized,
                tests: n.tests.len(),
                disabled: n.disabled,
            }
        })
        .collect();
    Json(body).into_response()
}

#[derive(Deserialize)]
struct NodeQuery {
    #[serde(default)]
    id: String,
    #[serde(default)]
    file: String,
}

#[derive(serde::Serialize)]
struct Ref<'a> {
    id: &'a str,
    name: &'a str,
    kind: Kind,
    file: &'a str,
    materialized: &'a str,
    disabled: bool,
}

#[derive(serde::Serialize)]
struct Col<'a> {
    name: &'a str,
    data_type: &'a str,
    description: &'a str,
    tests: &'a [String],
    undeclared: bool,
    up: usize,
    down: usize,
}

/// The same node at three stages: as written, as dbt parsed it, and where it
/// was actually built once the generate_*_name macros ran. `parsed` and `built`
/// come from the same parse, which is what makes comparing them meaningful.
#[derive(serde::Serialize)]
struct Location<'a> {
    written: &'a Place,
    parsed: &'a Place,
    built: Place,
    /// `written` evaluated against each discovered `.env` file on its own,
    /// keyed by file name. The browser picks one, so switching environment
    /// needs no request.
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    envs: std::collections::BTreeMap<String, envs::Resolution>,
}

#[derive(serde::Serialize)]
struct NodeDetail<'a> {
    id: &'a str,
    name: &'a str,
    kind: Kind,
    file: &'a str,
    yml: &'a str,
    schema: &'a str,
    database: &'a str,
    relation: &'a str,
    materialized: &'a str,
    strategy: &'a str,
    unique_key: &'a str,
    package: &'a str,
    description: &'a str,
    tags: &'a [String],
    disabled: bool,
    location: Location<'a>,
    columns: Vec<Col<'a>>,
    upstream_total: usize,
    downstream_total: usize,
    parents: Vec<Ref<'a>>,
    children: Vec<Ref<'a>>,
    tests: Vec<Ref<'a>>,
}

/// Node detail, looked up either by unique_id or by the file currently open in
/// the editor (so the editor and the lineage view stay in sync).
async fn node(State(st): State<Arc<AppState>>, Query(q): Query<NodeQuery>) -> Response {
    let graph = st.graph.read().await.clone();
    let idx = if !q.id.is_empty() {
        graph.index.get(&q.id).copied()
    } else {
        let key = q.file.replace('\\', "/");
        graph
            .by_file
            .get(&key)
            .and_then(|v| v.iter().find(|&&i| graph.nodes[i as usize].kind != Kind::Test).or(v.first()))
            .copied()
    };
    let Some(idx) = idx else {
        return (StatusCode::NOT_FOUND, "unknown node").into_response();
    };
    let n = &graph.nodes[idx as usize];
    // A handful of files of a few kilobytes each, read fresh so an edit to a
    // .env file shows up on the next click.
    let env_files = {
        let root = st.root.clone();
        tokio::task::spawn_blocking(move || envs::discover(&root)).await.unwrap_or_default()
    };
    let has_location = !n.written.database.is_empty() || !n.written.schema.is_empty() || !n.parsed.database.is_empty();
    let as_ref = |i: &u32| {
        let t = &graph.nodes[*i as usize];
        Ref {
            id: &t.id,
            name: &t.name,
            kind: t.kind,
            file: &t.file,
            materialized: &t.materialized,
            disabled: t.disabled,
        }
    };
    Json(NodeDetail {
        id: &n.id,
        name: &n.name,
        kind: n.kind,
        file: &n.file,
        yml: &n.yml,
        schema: &n.schema,
        database: &n.database,
        relation: &n.relation,
        materialized: &n.materialized,
        strategy: &n.strategy,
        unique_key: &n.unique_key,
        package: &n.package,
        description: &n.description,
        tags: &n.tags,
        disabled: n.disabled,
        location: Location {
            written: &n.written,
            parsed: &n.parsed,
            built: Place { database: n.database.clone(), schema: n.schema.clone(), alias: n.alias.clone() },
            envs: if has_location { envs::resolve_all(&env_files, &n.written, &n.parsed) } else { Default::default() },
        },
        columns: n
            .columns
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let (up, down) = graph
                    .cll
                    .as_ref()
                    .map(|l| l.degree(ColRef { node: idx, col: i as u32 }))
                    .unwrap_or((0, 0));
                Col {
                    name: &c.name,
                    data_type: &c.data_type,
                    description: &c.description,
                    tests: &c.tests,
                    undeclared: c.undeclared,
                    up,
                    down,
                }
            })
            .collect(),
        upstream_total: graph.reach(idx, true),
        downstream_total: graph.reach(idx, false),
        parents: n.parents.iter().map(as_ref).collect(),
        children: n.children.iter().map(as_ref).collect(),
        tests: n.tests.iter().map(as_ref).collect(),
    })
    .into_response()
}

#[derive(Deserialize)]
struct ResolveBody {
    names: Vec<String>,
}

#[derive(serde::Serialize)]
struct Resolved<'a> {
    name: &'a str,
    id: &'a str,
    file: &'a str,
    kind: Kind,
    materialized: &'a str,
    description: &'a str,
    disabled: bool,
}

/// Maps the names found in `ref()` / `source()` calls onto dbt nodes, so the
/// editor can turn them into links.
async fn resolve(State(st): State<Arc<AppState>>, Json(body): Json<ResolveBody>) -> Response {
    let graph = st.graph.read().await.clone();
    let out: Vec<Resolved> = body
        .names
        .iter()
        .filter_map(|name| {
            let &i = graph.by_name.get(name.as_str())?;
            let n = &graph.nodes[i as usize];
            Some(Resolved {
                name: &n.name,
                id: &n.id,
                file: &n.file,
                kind: n.kind,
                materialized: &n.materialized,
                description: n.description.split('\n').next().unwrap_or(""),
                disabled: n.disabled,
            })
        })
        .collect();
    Json(out).into_response()
}

#[derive(Deserialize)]
struct LineageQuery {
    id: String,
    #[serde(default = "two")]
    up: u32,
    #[serde(default = "two")]
    down: u32,
    #[serde(default)]
    tests: u8,
    #[serde(default)]
    max: Option<usize>,
}
fn two() -> u32 {
    2
}

async fn lineage(State(st): State<Arc<AppState>>, Query(q): Query<LineageQuery>) -> Response {
    let graph = st.graph.read().await.clone();
    let Some(&idx) = graph.index.get(&q.id) else {
        return (StatusCode::NOT_FOUND, "unknown node").into_response();
    };
    let sub = graph.lineage(idx, q.up.min(20), q.down.min(20), q.tests == 1, q.max.unwrap_or(400).min(3000));
    Json(sub).into_response()
}

#[derive(serde::Serialize)]
struct EnvEntry {
    file: String,
    name: String,
    auto_name: String,
    /// `DBT_TARGET` from the file: the one raw value this endpoint returns,
    /// shown as a cross-check against the name.
    target: String,
    target_mismatch: bool,
    hidden: bool,
    hidden_reason: Option<String>,
    /// What automatic detection alone would decide, so the panel can tell an
    /// explicit choice from a default and store only real overrides.
    auto_hidden_reason: Option<String>,
    coverage: envs::Coverage,
    agreement: envs::Agreement,
    warnings: Vec<envs::Warning>,
}

#[derive(serde::Serialize)]
struct EnvsBody {
    files: Vec<EnvEntry>,
    referenced: Vec<envs::RefVar>,
    selected: Option<String>,
    settings_path: String,
    persist: bool,
}

/// The discovered `.env` files and how each one covers the variables the
/// project's location config reads. Variable names only, never their values.
async fn list_envs(State(st): State<Arc<AppState>>) -> Response {
    let graph = st.graph.read().await.clone();
    let root = st.root.clone();
    let settings = st.settings.load();
    let settings_path = st.settings.path.as_ref().map(|p| p.display().to_string()).unwrap_or_default();
    let body = tokio::task::spawn_blocking(move || {
        let places: Vec<(&Place, &Place)> =
            graph.nodes.iter().filter(|n| n.kind != Kind::Test).map(|n| (&n.written, &n.parsed)).collect();
        let referenced = envs::referenced(&places);
        let files = envs::discover(&root)
            .into_iter()
            .map(|f| {
                let coverage = envs::coverage(&f, &referenced);
                let auto_reason = envs::auto_hidden(&f, &coverage, &referenced);
                let over = settings.envs.get(&f.file).cloned().unwrap_or_default();
                // A user's explicit choice beats the automatic one in both directions.
                let (hidden, hidden_reason) = match over.hidden {
                    Some(true) => (true, Some("hidden by you".to_string())),
                    Some(false) => (false, None),
                    None => (auto_reason.is_some(), auto_reason.map(str::to_string)),
                };
                EnvEntry {
                    name: over.name.clone().unwrap_or_else(|| f.auto_name.clone()),
                    auto_name: f.auto_name.clone(),
                    target_mismatch: envs::target_mismatch(&f),
                    hidden,
                    hidden_reason,
                    auto_hidden_reason: auto_reason.map(str::to_string),
                    agreement: envs::agreement(places.iter().copied(), &f.vars),
                    coverage,
                    target: f.target.clone(),
                    warnings: f.warnings.clone(),
                    file: f.file,
                }
            })
            .collect::<Vec<EnvEntry>>();
        // A stored choice only counts while its file still exists and is visible.
        let selected = settings.selected.filter(|s| files.iter().any(|f| &f.file == s && !f.hidden));
        let persist = !settings_path.is_empty();
        EnvsBody { files, referenced, selected, settings_path, persist }
    })
    .await;
    match body {
        Ok(body) => Json(body).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// `.env` or `.env.<suffix>`, a plain file name and nothing that could walk out
/// of the project directory.
fn valid_env_file(file: &str) -> bool {
    (file == ".env" || file.starts_with(".env.")) && !file.contains(['/', '\\']) && !file.contains("..")
}

#[derive(Deserialize)]
struct SelectBody {
    file: Option<String>,
}

/// Stores where a fresh tab starts. Touches nothing but the selection, so it
/// cannot undo a rename saved from another tab.
async fn select_env(State(st): State<Arc<AppState>>, Json(b): Json<SelectBody>) -> Response {
    if let Some(f) = &b.file {
        if !valid_env_file(f) {
            return (StatusCode::BAD_REQUEST, "not an env file name").into_response();
        }
    }
    match st.settings.update(|s| s.selected = b.file).await {
        Ok(_) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

#[derive(Deserialize)]
struct OverridesBody {
    envs: std::collections::BTreeMap<String, crate::settings::EnvOverride>,
}

/// Saves names and visibility from the Manage panel. Touches nothing but those.
async fn save_envs(State(st): State<Arc<AppState>>, Json(b): Json<OverridesBody>) -> Response {
    let mut cleaned = std::collections::BTreeMap::new();
    for (file, over) in b.envs {
        if !valid_env_file(&file) {
            return (StatusCode::BAD_REQUEST, "not an env file name").into_response();
        }
        // An empty name means "use the automatic one".
        let name = over.name.map(|n| n.trim().chars().take(32).collect::<String>()).filter(|n| !n.is_empty());
        cleaned.insert(file, crate::settings::EnvOverride { name, hidden: over.hidden });
    }
    let result = st
        .settings
        .update(|s| {
            for (file, over) in cleaned {
                if over == crate::settings::EnvOverride::default() {
                    s.envs.remove(&file);
                } else {
                    s.envs.insert(file, over);
                }
            }
        })
        .await;
    match result {
        Ok(_) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// Compiled SQL for one node, with the freshness signals the UI colours on.
async fn compiled_sql(State(st): State<Arc<AppState>>, Query(q): Query<NodeQuery>) -> Response {
    let graph = st.graph.read().await.clone();
    let Some(&idx) = graph.index.get(&q.id) else {
        return (StatusCode::NOT_FOUND, "unknown node").into_response();
    };
    let n = &graph.nodes[idx as usize];
    let (root, target) = (st.root.clone(), st.target_dir.clone());
    let (package, file, yml) = (n.package.clone(), n.file.clone(), n.yml.clone());
    match tokio::task::spawn_blocking(move || {
        compiled::look_up(&root, &target, &package, &file, &yml, 2 * 1024 * 1024)
    })
    .await
    {
        Ok(info) => Json(info).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct ColLineageQuery {
    id: String,
    column: String,
    #[serde(default = "two")]
    up: u32,
    #[serde(default = "two")]
    down: u32,
    #[serde(default)]
    max: Option<usize>,
}

/// Column-level lineage around one column. Columns fan out harder than models,
/// hence the lower default cap.
async fn col_lineage(State(st): State<Arc<AppState>>, Query(q): Query<ColLineageQuery>) -> Response {
    let graph = st.graph.read().await.clone();
    if graph.cll.is_none() {
        return (StatusCode::NOT_FOUND, "no column lineage").into_response();
    }
    let Some(&idx) = graph.index.get(&q.id) else {
        return (StatusCode::NOT_FOUND, "unknown node").into_response();
    };
    let Some(col) = graph.col_slot(idx, &q.column) else {
        return (StatusCode::NOT_FOUND, "unknown column").into_response();
    };
    let sub = graph.column_lineage(
        ColRef { node: idx, col },
        q.up.min(20),
        q.down.min(20),
        q.max.unwrap_or(200).min(2000),
    );
    Json(sub).into_response()
}

// ------------------------------------------------------------- snowflake ----

#[derive(serde::Serialize)]
struct SidecarBody {
    enabled: bool,
    #[serde(flatten)]
    status: sidecar::Status,
}

async fn sidecar_status(State(st): State<Arc<AppState>>) -> Response {
    Json(SidecarBody { enabled: st.sidecar.enabled(), status: st.sidecar.status() }).into_response()
}

#[derive(Deserialize)]
struct SwitchBody {
    enabled: bool,
}

/// Switches Snowflake lineage on or off for this project. On starts the script,
/// which checks its setup and then waits: no connection opens until a column
/// is clicked (0016).
async fn sidecar_switch(State(st): State<Arc<AppState>>, Json(b): Json<SwitchBody>) -> Response {
    st.sidecar.set_enabled(b.enabled);
    // Remembered like the environment selection. Without a configuration
    // directory the switch still holds until dbt-lens stops.
    if let Err(e) = st.settings.update(|s| s.snowflake_lineage = b.enabled).await {
        eprintln!("  snowflake lineage switch not saved: {e}");
    }
    let status = if b.enabled { st.sidecar.start_for(&st.root, &st.venv).await } else { st.sidecar.stop().await };
    Json(SidecarBody { enabled: st.sidecar.enabled(), status }).into_response()
}

/// A dbt profile is a few kilobytes; anything of this size is not one.
const MAX_PROFILE_BYTES: u64 = 512 * 1024;

#[derive(serde::Serialize)]
struct ProfileBody {
    path: String,
    content: String,
}

fn profile_on_disk(path: &Path) -> Result<ProfileBody, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    if meta.len() > MAX_PROFILE_BYTES {
        return Err(format!("{} is far larger than a dbt profile, so it is left alone", path.display()));
    }
    let content = std::fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    Ok(ProfileBody { path: path.display().to_string(), content })
}

/// Why there is nothing to open yet.
const NO_PROFILE: &str = "no profile yet: switch Snowflake lineage on once, so the script says which file it reads";

/// The dbt profile the Snowflake script read: the one file outside the project
/// dbt-lens opens, and only because the script named it first (0017). No path
/// comes from the browser, so no request can widen the exception.
async fn read_profile(State(st): State<Arc<AppState>>) -> Response {
    let Some(path) = st.sidecar.profile_path() else {
        return (StatusCode::CONFLICT, NO_PROFILE).into_response();
    };
    match tokio::task::spawn_blocking(move || profile_on_disk(&path)).await {
        Ok(Ok(body)) => Json(body).into_response(),
        Ok(Err(e)) => (StatusCode::NOT_FOUND, e).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct ProfileWrite {
    content: String,
}

#[derive(serde::Serialize)]
struct ProfileSaved {
    path: String,
    /// The script reads the profile once, when it starts, so saving restarts it.
    restarted: bool,
    #[serde(flatten)]
    status: sidecar::Status,
}

/// Saves that same file, and only if it is already there: this route never
/// creates a file, and never takes a path (0017). The write is atomic, so a
/// half-written profile cannot be left behind.
async fn write_profile(State(st): State<Arc<AppState>>, Json(b): Json<ProfileWrite>) -> Response {
    let Some(path) = st.sidecar.profile_path() else {
        return (StatusCode::CONFLICT, NO_PROFILE).into_response();
    };
    if b.content.len() as u64 > MAX_PROFILE_BYTES {
        return (StatusCode::BAD_REQUEST, "far larger than a dbt profile, so it is not written").into_response();
    }
    if !path.is_file() {
        return (StatusCode::NOT_FOUND, format!("{} is no longer there", path.display())).into_response();
    }
    let (target, content) = (path.clone(), b.content);
    match tokio::task::spawn_blocking(move || crate::settings::write_atomic(&target, content.as_bytes())).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("cannot write {}: {e}", path.display())).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
    // A correction nobody reads is worse than no correction: the script holds
    // the profile it read at startup, so it starts again on the new one.
    let restarted = st.sidecar.enabled();
    let status = if restarted { st.sidecar.restart(&st.root, &st.venv).await } else { st.sidecar.status() };
    Json(ProfileSaved { path: path.display().to_string(), restarted, status }).into_response()
}

#[derive(Deserialize)]
struct FetchBody {
    id: String,
    column: String,
    /// The clicked node's relation as the browser shows it for the selected
    /// environment, so Snowflake is asked about exactly what the user sees.
    relation: String,
    /// The selected `.env` file, empty for the manifest.
    #[serde(default)]
    env: String,
    #[serde(default = "two")]
    up: u32,
    #[serde(default = "two")]
    down: u32,
}

/// A fetch that failed, with the phase that says whether the profile is to
/// blame, so the UI can point at it without reading Snowflake's error codes.
#[derive(serde::Serialize)]
struct FetchFailed {
    error: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    phase: String,
}

#[derive(serde::Serialize)]
struct Fetched {
    relation: String,
    /// Column pairs Snowflake returned, both directions together.
    rows: usize,
    /// Edges the cache did not have yet.
    added: usize,
    /// Edges on the clicked column now, from the cache as it stands.
    up: usize,
    down: usize,
    /// Objects Snowflake named that are no node of this project, the first 20.
    unmatched: Vec<String>,
    unmatched_total: usize,
}

/// Column lineage from Snowflake around one clicked column, merged into the
/// cache file and into the graph in memory. POST and never GET: a GET passes
/// the guard on its Host alone, so any page could run warehouse queries
/// through an image tag (0015, 0016).
async fn fetch_col_lineage(State(st): State<Arc<AppState>>, Json(b): Json<FetchBody>) -> Response {
    if !st.sidecar.enabled() {
        return (StatusCode::CONFLICT, "Snowflake lineage is switched off").into_response();
    }
    if !collin::valid_relation(&b.relation) {
        return (StatusCode::BAD_REQUEST, "not a database.schema.object relation").into_response();
    }
    if b.column.trim().is_empty() || b.column.len() > 256 || b.column.chars().any(char::is_control) {
        return (StatusCode::BAD_REQUEST, "not a column name").into_response();
    }
    if !b.env.is_empty() && !valid_env_file(&b.env) {
        return (StatusCode::BAD_REQUEST, "not an env file name").into_response();
    }
    {
        // Refused before any query: a result that cannot be stored is not
        // worth a sign-in tab.
        let graph = st.graph.read().await;
        if !graph.index.contains_key(&b.id) {
            return (StatusCode::NOT_FOUND, "unknown node").into_response();
        }
        if graph.meta.cll_edges > 0 && graph.meta.cll_source != "snowflake" {
            return (StatusCode::CONFLICT, collin::other_source(&st.cll_path, &graph.meta.cll_source)).into_response();
        }
    }
    // The file's values stay on the server: they only decide which node an
    // object stands for.
    let vars = if b.env.is_empty() {
        None
    } else {
        let (root, file) = (st.root.clone(), b.env.clone());
        match tokio::task::spawn_blocking(move || envs::discover(&root).into_iter().find(|f| f.file == file)).await {
            Ok(Some(found)) => Some(found.vars),
            _ => return (StatusCode::NOT_FOUND, "that env file is no longer in the project").into_response(),
        }
    };

    if !st.sidecar.is_up() {
        let status = st.sidecar.start_for(&st.root, &st.venv).await;
        if status.state != "ready" {
            let why = if status.error.is_empty() { "Snowflake lineage is switched off".to_string() } else { status.error };
            return (StatusCode::BAD_GATEWAY, why).into_response();
        }
    }
    let mut rows = Vec::new();
    for (direction, depth) in [("UPSTREAM", b.up), ("DOWNSTREAM", b.down)] {
        if depth == 0 {
            continue;
        }
        // GET_LINEAGE goes five levels deep at most.
        match st.sidecar.query(&b.relation, &b.column, direction, depth.min(5)).await {
            Ok(found) => rows.extend(found),
            Err(e) => {
                let body = FetchFailed { error: e.message, phase: e.phase };
                return (StatusCode::BAD_GATEWAY, Json(body)).into_response();
            }
        }
    }

    let total = rows.len();
    let graph = st.graph.read().await.clone();
    let Some(&focus) = graph.index.get(&b.id) else {
        return (StatusCode::NOT_FOUND, "unknown node").into_response();
    };
    let relation = b.relation.clone();
    // The graph moves into the task and is dropped with it, so the merge below
    // can usually update the graph in place instead of copying it.
    let mapped = tokio::task::spawn_blocking(move || collin::edges_for(&graph, &rows, focus, &relation, vars.as_ref())).await;
    let Ok((edges, unmatched)) = mapped else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "matching the lineage to the project failed").into_response();
    };

    let _cache = st.cll_lock.lock().await;
    let (path, target) = (st.cll_path.clone(), st.sidecar.status().target);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let merged = match tokio::task::spawn_blocking(move || collin::add_to_file(&path, edges, &target, now)).await {
        Ok(Ok(merged)) => merged,
        Ok(Err(e)) => return (StatusCode::CONFLICT, e).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    let mut added = 0;
    if let Some((cache, n)) = merged {
        added = n;
        let mtime = mtime_secs(&st.cll_path);
        if let Ok(mut seen) = st.seen.lock() {
            seen[2] = mtime;
        }
        let mut current = st.graph.write().await;
        let graph = Arc::make_mut(&mut current);
        graph.merge_col_lineage(cache, mtime);
        graph.meta.cll_file = st.cll_path.display().to_string();
    }
    let graph = st.graph.read().await.clone();
    let (up, down) = match (graph.cll.as_ref(), graph.index.get(&b.id)) {
        (Some(cll), Some(&node)) => graph.col_slot(node, &b.column).map_or((0, 0), |col| cll.degree(ColRef { node, col })),
        _ => (0, 0),
    };
    Json(Fetched {
        relation: b.relation,
        rows: total,
        added,
        up,
        down,
        unmatched_total: unmatched.len(),
        unmatched: unmatched.into_iter().take(20).collect(),
    })
    .into_response()
}

#[derive(Deserialize)]
struct PathQuery {
    #[serde(default)]
    path: String,
}

async fn dir(State(st): State<Arc<AppState>>, Query(q): Query<PathQuery>) -> Response {
    match files::list_dir(&st.root, &q.path) {
        Ok(entries) => Json(entries).into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
struct FileQuery {
    #[serde(default)]
    q: String,
    #[serde(default)]
    limit: Option<usize>,
}

/// Every file in the project, not just the ones dbt knows about: generic test
/// definitions, macros, scripts and dotfiles are all things you search for.
async fn file_search(State(st): State<Arc<AppState>>, Query(q): Query<FileQuery>) -> Response {
    let index = st.file_index.read().await.clone();
    let hits = files::search_paths(&index, &q.q, q.limit.unwrap_or(60).min(500));
    Json(hits).into_response()
}

/// The index is a directory walk, cheap enough to simply redo on a timer so a
/// branch switch or a new file shows up without any invalidation logic.
pub async fn watch_files(st: Arc<AppState>) {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        let root = st.root.clone();
        if let Ok(list) = tokio::task::spawn_blocking(move || files::scan(&root)).await {
            *st.file_index.write().await = Arc::new(list);
        }
    }
}

async fn read_file(State(st): State<Arc<AppState>>, Query(q): Query<PathQuery>) -> Response {
    match files::read_file(&st.root, &q.path) {
        Ok(body) => Json(body).into_response(),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
struct WriteBody {
    path: String,
    content: String,
}

async fn write_file(State(st): State<Arc<AppState>>, Json(body): Json<WriteBody>) -> Response {
    match files::write_file(&st.root, &body.path, &body.content) {
        Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
        Err(e) => err(e),
    }
}

/// Working-tree status, cached briefly so that polling from the explorer does
/// not fork a git process on every tick.
async fn git_status(State(st): State<Arc<AppState>>) -> Response {
    let mut cached = st.git.lock().await;
    if let Some((at, info)) = cached.as_ref() {
        if at.elapsed() < std::time::Duration::from_millis(1500) {
            return Json(info.clone()).into_response();
        }
    }
    let root = st.root.clone();
    let info = tokio::task::spawn_blocking(move || git::status(&root))
        .await
        .unwrap_or_default();
    *cached = Some((std::time::Instant::now(), info.clone()));
    Json(info).into_response()
}

/// Runs one git action off the async runtime, then drops the status cache so
/// the next poll shows the new state rather than a stale one.
async fn git_do<F>(st: &Arc<AppState>, f: F) -> Response
where
    F: FnOnce(PathBuf) -> git::GitRun + Send + 'static,
{
    let root = st.root.clone();
    let out = tokio::task::spawn_blocking(move || f(root)).await;
    *st.git.lock().await = None;
    match out {
        Ok(run) => Json(run).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// Paths come from the browser, so keep them inside the repository. git would
/// refuse anything outside anyway; this just fails earlier and more clearly.
/// Both separators count, and so does a drive or UNC prefix: on Windows,
/// `Path::join` replaces the root with either.
fn sane_path(p: &str) -> bool {
    let unified = p.replace('\\', "/");
    !p.is_empty()
        && !unified.starts_with('/')
        && !unified.split('/').any(|seg| seg == ".." || seg.ends_with(':'))
}

fn sane_paths(paths: &[String]) -> Result<(), Response> {
    for p in paths {
        if !sane_path(p) {
            return Err((StatusCode::BAD_REQUEST, format!("refusing path {p:?}")).into_response());
        }
    }
    Ok(())
}

async fn git_branches(State(st): State<Arc<AppState>>) -> Response {
    let root = st.root.clone();
    match tokio::task::spawn_blocking(move || git::branches(&root)).await {
        Ok(b) => Json(b).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// The working-tree side is read from disk, so the path goes through the same
/// confinement as the editor rather than the lighter check git actions get.
async fn git_diff(State(st): State<Arc<AppState>>, Query(q): Query<PathQuery>) -> Response {
    let on_disk = match files::resolve(&st.root, &q.path) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    let (root, rel) = (st.root.clone(), q.path.replace('\\', "/"));
    match tokio::task::spawn_blocking(move || git::diff(&root, &rel, &on_disk, 2 * 1024 * 1024)).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn git_outgoing(State(st): State<Arc<AppState>>) -> Response {
    let root = st.root.clone();
    match tokio::task::spawn_blocking(move || git::outgoing(&root)).await {
        Ok(c) => Json(c).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct CheckoutBody {
    branch: String,
    /// Only ever true when the user has seen the blocking files and said so.
    #[serde(default)]
    stash: bool,
}

async fn git_checkout(State(st): State<Arc<AppState>>, Json(b): Json<CheckoutBody>) -> Response {
    if b.branch.is_empty() || b.branch.starts_with('-') {
        return (StatusCode::BAD_REQUEST, "bad branch name").into_response();
    }
    git_do(&st, move |root| git::checkout(&root, &b.branch, b.stash)).await
}

#[derive(Deserialize)]
struct PathsBody {
    paths: Vec<String>,
}

async fn git_stage(State(st): State<Arc<AppState>>, Json(b): Json<PathsBody>) -> Response {
    if let Err(e) = sane_paths(&b.paths) {
        return e;
    }
    git_do(&st, move |root| git::stage(&root, &b.paths)).await
}

async fn git_unstage(State(st): State<Arc<AppState>>, Json(b): Json<PathsBody>) -> Response {
    if let Err(e) = sane_paths(&b.paths) {
        return e;
    }
    git_do(&st, move |root| git::unstage(&root, &b.paths)).await
}

#[derive(Deserialize)]
struct CommitBody {
    message: String,
}

#[derive(serde::Serialize)]
struct CommitResult {
    #[serde(flatten)]
    run: git::GitRun,
    #[serde(skip_serializing_if = "Option::is_none")]
    fetch_note: Option<String>,
}

async fn git_commit(State(st): State<Arc<AppState>>, Json(b): Json<CommitBody>) -> Response {
    if b.message.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "empty commit message").into_response();
    }
    let root = st.root.clone();
    let out = tokio::task::spawn_blocking(move || git::commit(&root, &b.message)).await;
    *st.git.lock().await = None;
    match out {
        Ok((run, fetch_note)) => Json(CommitResult { run, fetch_note }).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn git_push(State(st): State<Arc<AppState>>) -> Response {
    git_do(&st, |root| git::push(&root)).await
}

async fn git_pull(State(st): State<Arc<AppState>>) -> Response {
    git_do(&st, |root| git::pull(&root)).await
}

async fn git_fetch(State(st): State<Arc<AppState>>) -> Response {
    git_do(&st, |root| git::fetch(&root)).await
}

async fn git_merge_abort(State(st): State<Arc<AppState>>) -> Response {
    git_do(&st, |root| git::merge_abort(&root)).await
}

// -------------------------------------------------------------- terminal ----

#[derive(Deserialize)]
struct TermQuery {
    #[serde(default = "default_cols")]
    cols: u16,
    #[serde(default = "default_rows")]
    rows: u16,
}
fn default_cols() -> u16 {
    120
}
fn default_rows() -> u16 {
    30
}

#[derive(Deserialize)]
#[serde(tag = "t")]
enum ClientMsg {
    #[serde(rename = "i")]
    Input { d: String },
    #[serde(rename = "r")]
    Resize { cols: u16, rows: u16 },
}

async fn ws_pty(ws: WebSocketUpgrade, State(st): State<Arc<AppState>>, Query(q): Query<TermQuery>) -> Response {
    ws.on_upgrade(move |socket| terminal_loop(socket, st, q))
}

async fn terminal_loop(socket: WebSocket, st: Arc<AppState>, q: TermQuery) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = tokio::sync::mpsc::channel::<FromPty>(512);

    let session = match PtySession::spawn(&st.shell, &st.root, q.cols.max(20), q.rows.max(5), tx) {
        Ok(s) => s,
        Err(e) => {
            let _ = sink.send(Message::Text(format!("\r\n[dbt-lens] cannot start shell: {e}\r\n").into())).await;
            return;
        }
    };

    loop {
        tokio::select! {
            from_pty = rx.recv() => match from_pty {
                Some(FromPty::Output(bytes)) => {
                    if sink.send(Message::Binary(bytes.into())).await.is_err() { break; }
                }
                _ => {
                    let _ = sink.send(Message::Text("\r\n[dbt-lens] shell exited\r\n".into())).await;
                    break;
                }
            },
            from_ws = stream.next() => match from_ws {
                Some(Ok(Message::Text(text))) => {
                    match serde_json::from_str::<ClientMsg>(&text) {
                        Ok(ClientMsg::Input { d }) => session.write(d.into_bytes()),
                        Ok(ClientMsg::Resize { cols, rows }) => session.resize(cols.max(20), rows.max(5)),
                        Err(_) => {}
                    }
                }
                Some(Ok(Message::Binary(bytes))) => session.write(bytes.to_vec()),
                Some(Ok(_)) => {}
                _ => break,
            },
        }
    }
    session.kill();
}

/// Background poll: reloads whenever dbt rewrites manifest.json or catalog.json,
/// or something other than a click rewrites the column-lineage cache.
pub async fn watch_artifacts(st: Arc<AppState>) {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        // Held through the reload: a click merging fetched lineage meanwhile
        // would otherwise merge into the graph this reload is about to replace.
        let _cache = st.cll_lock.lock().await;
        let (mp, cp, lp) = (st.manifest_path.clone(), st.catalog_path.clone(), st.cll_path.clone());
        let stamps = tokio::task::spawn_blocking(move || [mtime_secs(&mp), mtime_secs(&cp), mtime_secs(&lp)])
            .await
            .unwrap_or([0, 0, 0]);
        let changed = st.seen.lock().is_ok_and(|mut seen| {
            let changed = stamps.iter().zip(seen.iter()).any(|(now, before)| *now != 0 && now != before);
            if changed {
                *seen = stamps;
            }
            changed
        });
        if !changed {
            continue;
        }
        // Give dbt a moment to finish writing.
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let (mp, cp, lp) = (st.manifest_path.clone(), st.catalog_path.clone(), st.cll_path.clone());
        if let Ok(Ok(g)) = tokio::task::spawn_blocking(move || load_graph(&mp, &cp, &lp)).await {
            eprintln!("  artifacts reloaded ({} nodes, {} ms)", g.nodes.len(), g.meta.load_ms);
            *st.graph.write().await = Arc::new(g);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn host_must_name_this_server_exactly() {
        assert!(host_allowed(Some("127.0.0.1:4321"), 4321));
        assert!(host_allowed(Some("localhost:4321"), 4321));
        assert!(!host_allowed(Some("127.0.0.1:4322"), 4321));
        assert!(!host_allowed(Some("127.0.0.1"), 4321));
        assert!(!host_allowed(Some("evil.example:4321"), 4321));
        assert!(!host_allowed(Some("127.0.0.1:4321.evil.example"), 4321));
        assert!(!host_allowed(None, 4321));
    }

    #[test]
    fn origin_must_be_this_servers_page() {
        assert!(origin_allowed(Some("http://127.0.0.1:4321"), 4321, true));
        assert!(origin_allowed(Some("http://localhost:4321"), 4321, true));
        assert!(!origin_allowed(Some("https://evil.example"), 4321, false));
        assert!(!origin_allowed(Some("http://127.0.0.1:4322"), 4321, false));
        assert!(!origin_allowed(Some("null"), 4321, false));
        // Absent means a local tool, not a browser: fine for a plain request,
        // never for a WebSocket handshake, where browsers always send it.
        assert!(origin_allowed(None, 4321, false));
        assert!(!origin_allowed(None, 4321, true));
    }

    #[test]
    fn git_paths_stay_inside_the_repository_on_every_platform() {
        assert!(sane_path("models/stg_orders.sql"));
        assert!(sane_path("models\\stg_orders.sql"));
        assert!(!sane_path(""));
        assert!(!sane_path("/etc/passwd"));
        assert!(!sane_path("../secret"));
        assert!(!sane_path("..\\..\\secret"));
        assert!(!sane_path("models/../../secret"));
        assert!(!sane_path("C:/Users/me/.ssh/id_rsa"));
        assert!(!sane_path("C:\\Users\\me\\.ssh\\id_rsa"));
        assert!(!sane_path("\\\\server\\share\\x"));
    }

    fn temp_project(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dbt-lens-api-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("dbt_project.yml"), "name: demo\n").unwrap();
        std::fs::write(dir.join(".env"), "DBT_ENV_SECRET_PW=hunter2\n").unwrap();
        dir.canonicalize().unwrap()
    }

    /// A real server on a free port, so the guard is exercised the way a
    /// browser reaches it: raw HTTP over TCP, no client library.
    async fn serve(root: &Path) -> (u16, Arc<AppState>, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let manifest = root.join("target").join("manifest.json");
        let state: Arc<AppState> = Arc::new(AppState {
            port,
            root: root.to_path_buf(),
            manifest_path: manifest.clone(),
            catalog_path: root.join("target").join("catalog.json"),
            cll_path: root.join("target").join("column_lineage.json"),
            target_dir: root.join("target"),
            venv: VenvInfo::default(),
            file_index: RwLock::new(Arc::new(Vec::new())),
            settings: crate::settings::Store::new(root),
            graph: RwLock::new(Arc::new(Graph::build(Default::default(), &manifest, 0, 0))),
            git: tokio::sync::Mutex::new(None),
            shell: ShellSpec { program: "/bin/sh".into(), args: Vec::new() },
            sidecar: sidecar::Sidecar::new(false, Default::default()),
            cll_lock: tokio::sync::Mutex::new(()),
            seen: std::sync::Mutex::new([0; 3]),
        });
        let held = state.clone();
        let task = tokio::spawn(async move {
            axum::serve(listener, router(state)).await.unwrap();
        });
        (port, held, task)
    }

    /// Sends one raw request and returns the status line.
    async fn status_of(port: u16, request: String) -> String {
        head_of(port, request).await.lines().next().unwrap_or("").to_string()
    }

    /// The whole response head, for asserting on headers.
    async fn head_of(port: u16, request: String) -> String {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(request.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        let read = async {
            let mut chunk = [0u8; 1024];
            loop {
                let n = s.read(&mut chunk).await.unwrap_or(0);
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
        };
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), read).await;
        let text = String::from_utf8_lossy(&buf).into_owned();
        // The last chunk usually carries the start of the body with it.
        text.split("\r\n\r\n").next().unwrap_or("").to_string()
    }

    /// The whole response, head and body, for a route whose answer matters.
    async fn body_of(port: u16, request: String) -> String {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(request.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), s.read_to_end(&mut buf)).await;
        String::from_utf8_lossy(&buf).into_owned()
    }

    fn get(path: &str, headers: &[(&str, &str)]) -> String {
        raw("GET", path, headers)
    }

    fn raw(method: &str, path: &str, headers: &[(&str, &str)]) -> String {
        let mut r = format!("{method} {path} HTTP/1.1\r\n");
        for (k, v) in headers {
            r.push_str(&format!("{k}: {v}\r\n"));
        }
        r.push_str("Content-Length: 0\r\nConnection: close\r\n\r\n");
        r
    }

    #[tokio::test]
    async fn the_guard_refuses_other_pages_and_other_hosts() {
        let root = temp_project("guard");
        let (port, _st, server) = serve(&root).await;
        let host = format!("127.0.0.1:{port}");
        let own = format!("http://127.0.0.1:{port}");

        // The browser's own page keeps working, through either name.
        assert!(status_of(port, get("/api/file?path=.env", &[("Host", &host)])).await.ends_with("200 OK"));
        assert!(status_of(port, get("/api/meta", &[("Host", &format!("localhost:{port}"))])).await.ends_with("200 OK"));
        assert!(status_of(port, raw("POST", "/api/reload", &[("Host", &host), ("Origin", &own)])).await.ends_with("400 Bad Request"));
        // A local tool sends no Origin: still allowed on a plain request.
        assert!(status_of(port, raw("POST", "/api/reload", &[("Host", &host)])).await.ends_with("400 Bad Request"));

        // DNS rebinding: same IP, another name in Host.
        assert!(status_of(port, get("/api/file?path=.env", &[("Host", "evil.example")])).await.ends_with("403 Forbidden"));
        assert!(status_of(port, get("/api/file?path=.env", &[])).await.ends_with("403 Forbidden"));

        // Cross-site POST: no preflight protects a bodyless request, the guard does.
        let cross = raw("POST", "/api/git/fetch", &[("Host", &host), ("Origin", "https://evil.example")]);
        assert!(status_of(port, cross).await.ends_with("403 Forbidden"));
        let wrong_port = raw("POST", "/api/git/fetch", &[("Host", &host), ("Origin", "http://127.0.0.1:1")]);
        assert!(status_of(port, wrong_port).await.ends_with("403 Forbidden"));

        // The terminal: a handshake from another page, or with no Origin at all.
        let ws = |origin: Option<&str>| {
            let mut h = vec![
                ("Host", host.as_str()),
                ("Connection", "Upgrade"),
                ("Upgrade", "websocket"),
                ("Sec-WebSocket-Version", "13"),
                ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
            ];
            if let Some(o) = origin {
                h.push(("Origin", o));
            }
            get("/ws/pty", &h)
        };
        assert!(status_of(port, ws(Some("https://evil.example"))).await.ends_with("403 Forbidden"));
        assert!(status_of(port, ws(None)).await.ends_with("403 Forbidden"));
        assert!(status_of(port, ws(Some(&own))).await.ends_with("101 Switching Protocols"));

        server.abort();
        let _ = std::fs::remove_dir_all(&root);
    }

    fn with_json(method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> String {
        let mut r = format!("{method} {path} HTTP/1.1\r\n");
        for (k, v) in headers {
            r.push_str(&format!("{k}: {v}\r\n"));
        }
        r.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()));
        r
    }

    // Both routes can lead to warehouse queries under the user's own identity,
    // so no other page may reach them, and nothing runs while switched off.
    #[tokio::test]
    async fn snowflake_lineage_answers_only_this_page_and_only_when_switched_on() {
        let root = temp_project("snowflake");
        let (port, _st, server) = serve(&root).await;
        let host = format!("127.0.0.1:{port}");
        let own = format!("http://127.0.0.1:{port}");
        let fetch = r#"{"id":"model.shop.dim_customers","column":"customer_id","relation":"analytics.marts.dim_customers"}"#;

        for (path, body) in [("/api/sidecar", r#"{"enabled":true}"#), ("/api/collineage/fetch", fetch)] {
            let foreign = with_json("POST", path, &[("Host", &host), ("Origin", "https://evil.example")], body);
            assert!(status_of(port, foreign).await.ends_with("403 Forbidden"), "{path}");
        }
        // A plain read cannot start anything.
        assert!(status_of(port, get("/api/collineage/fetch", &[("Host", &host)])).await.ends_with("405 Method Not Allowed"));
        assert!(status_of(port, get("/api/sidecar", &[("Host", &host)])).await.ends_with("200 OK"));

        let off = with_json("POST", "/api/collineage/fetch", &[("Host", &host), ("Origin", &own)], fetch);
        assert!(status_of(port, off).await.ends_with("409 Conflict"));

        server.abort();
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The one file outside the project dbt-lens opens, and only because the
    /// script named it: the route itself takes no path at all (0017).
    #[cfg(unix)]
    #[tokio::test]
    async fn the_profile_is_read_and_written_where_the_script_said() {
        let root = temp_project("profile");
        let (port, st, server) = serve(&root).await;
        let host = format!("127.0.0.1:{port}");
        let own = format!("http://127.0.0.1:{port}");
        let put = |body: &str| with_json("PUT", "/api/profiles", &[("Host", &host), ("Origin", &own)], body);

        // Nothing has named a profile yet, so there is nothing to open.
        assert!(status_of(port, get("/api/profiles", &[("Host", &host)])).await.ends_with("409 Conflict"));
        assert!(status_of(port, put(r#"{"content":"x"}"#)).await.ends_with("409 Conflict"));
        // And no other page may write it.
        let foreign = with_json("PUT", "/api/profiles", &[("Host", &host), ("Origin", "https://evil.example")], r#"{"content":"x"}"#);
        assert!(status_of(port, foreign).await.ends_with("403 Forbidden"));

        // A script that names a profile, outside the project on purpose.
        let outside = std::env::temp_dir().join(format!("dbt-lens-profile-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&outside).unwrap();
        let profile = outside.join("profiles.yml");
        std::fs::write(&profile, "shop:\n  target: dev\n").unwrap();
        let script = outside.join("fake.sh");
        let announce = format!(
            "echo '{{\"event\":\"profiles\",\"path\":\"{}\"}}'\necho '{{\"event\":\"ready\"}}'\nwhile IFS= read -r line; do :; done\n",
            profile.display(),
        );
        std::fs::write(&script, announce).unwrap();
        let sh = [crate::sidecar::Interpreter { program: "/bin/sh".into(), args: Vec::new() }];
        st.sidecar.set_enabled(true);
        assert_eq!(st.sidecar.start(&sh, &script, &outside).await.state, "ready");

        let answer = body_of(port, get("/api/profiles", &[("Host", &host)])).await;
        assert!(answer.contains("target: dev"), "{answer}");
        assert!(answer.contains(&profile.display().to_string()), "{answer}");

        let saved = body_of(port, put(r#"{"content":"shop:\n  target: prod\n"}"#)).await;
        assert!(saved.contains("\"restarted\":true"), "{saved}");
        assert_eq!(std::fs::read_to_string(&profile).unwrap(), "shop:\n  target: prod\n");

        st.sidecar.stop().await;
        server.abort();
        let _ = std::fs::remove_dir_all(&outside);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn every_reply_carries_the_security_headers() {
        let root = temp_project("headers");
        let (port, _st, server) = serve(&root).await;
        let host = format!("127.0.0.1:{port}");
        for path in ["/", "/api/meta"] {
            let head = head_of(port, get(path, &[("Host", &host)])).await.to_lowercase();
            assert!(head.contains("x-content-type-options: nosniff"), "{path}: {head}");
            assert!(head.contains("referrer-policy: no-referrer"), "{path}: {head}");
            // Clickjacking the terminal is the one this closes.
            assert!(head.contains("frame-ancestors 'none'"), "{path}: {head}");
            assert!(head.contains("default-src 'none'"), "{path}: {head}");
            // The stray whitespace a line continuation leaves behind is not
            // wrong, but it is a sign the policy was edited carelessly.
            assert!(!head.contains("  "), "double space in a header: {head}");
        }
        server.abort();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_diff_path_cannot_leave_the_project() {
        let root = temp_project("diff");
        let (port, _st, server) = serve(&root).await;
        let host = format!("127.0.0.1:{port}");
        for p in ["..%5C..%5Cx", "../x", "C:/x", "C:%5Cx"] {
            let line = status_of(port, get(&format!("/api/git/diff?path={p}"), &[("Host", &host)])).await;
            assert!(line.ends_with("400 Bad Request"), "{p}: {line}");
        }
        // An absolute path is read relative to the root, as the editor does.
        let line = status_of(port, get("/api/git/diff?path=/etc/passwd", &[("Host", &host)])).await;
        assert!(line.ends_with("200 OK"), "{line}");
        // A deleted file in a deleted directory is still a valid diff target.
        let line = status_of(port, get("/api/git/diff?path=gone/away.sql", &[("Host", &host)])).await;
        assert!(line.ends_with("200 OK"), "{line}");
        server.abort();
        let _ = std::fs::remove_dir_all(&root);
    }
}
