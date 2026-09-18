//! `.env` files: reading them, and evaluating location config against one.
//!
//! Nothing here reads the process environment. A value only ever comes from
//! the file being evaluated, so a shell that sourced a different file (a CI one,
//! typically) cannot leak its values into another environment's answer.
//!
//! Values never reach a log or a warning: the only text a warning carries is a
//! line number and a fixed message.

use crate::graph::Place;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

pub type Vars = HashMap<String, String>;

/// Files larger than this are not `.env` files anyone maintains by hand.
const MAX_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Warning {
    pub line: usize,
    pub message: &'static str,
}

// ------------------------------------------------------------------ reading --

/// Bytes to text. A UTF-8 BOM is removed (`trim` leaves U+FEFF in place, which
/// would silently rename the first key), and UTF-16 with a BOM is decoded,
/// because Windows PowerShell 5.1 writes redirected output that way.
pub fn decode(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    if bytes.len() >= 2 {
        let little = bytes[0] == 0xFF && bytes[1] == 0xFE;
        let big = bytes[0] == 0xFE && bytes[1] == 0xFF;
        if little || big {
            let units: Vec<u16> = bytes[2..]
                .chunks_exact(2)
                .map(|c| if little { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
                .collect();
            return String::from_utf16_lossy(&units);
        }
    }
    String::from_utf8_lossy(bytes).into_owned()
}

fn valid_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// A value with at most one pair of surrounding quotes removed. A quoted value
/// ends at its first unescaped closing quote, so a JSON document inside single
/// quotes keeps every double quote it contains. In double quotes only `\"` and
/// `\\` are unescaped. Unquoted values stop at an inline ` #` comment.
fn unquote(value: &str) -> Result<String, &'static str> {
    let mut chars = value.chars();
    match chars.next() {
        Some(quote @ ('"' | '\'')) => {
            let mut out = String::new();
            let mut escaped = false;
            for c in chars {
                if escaped {
                    if c != '"' && c != '\\' {
                        out.push('\\');
                    }
                    out.push(c);
                    escaped = false;
                } else if c == '\\' && quote == '"' {
                    escaped = true;
                } else if c == quote {
                    return Ok(out);
                } else {
                    out.push(c);
                }
            }
            Err("unterminated quote")
        }
        _ => {
            let end = [value.find(" #"), value.find("\t#")].into_iter().flatten().min().unwrap_or(value.len());
            Ok(value[..end].trim_end().to_string())
        }
    }
}

/// `KEY=VALUE` lines, the way `source` reads them in practice: blank and `#`
/// lines skipped, an optional `export `, the last duplicate winning. Interpolation
/// such as `${OTHER}` is kept as text and reported, never evaluated.
pub fn parse(text: &str) -> (Vars, Vec<Warning>) {
    let mut vars = Vars::new();
    let mut warnings = Vec::new();
    for (index, raw) in text.lines().enumerate() {
        let line = index + 1;
        let mut body = raw.trim();
        if body.is_empty() || body.starts_with('#') {
            continue;
        }
        if let Some(rest) = body.strip_prefix("export ") {
            body = rest.trim_start();
        }
        let Some((key, value)) = body.split_once('=') else {
            warnings.push(Warning { line, message: "no '=' on this line" });
            continue;
        };
        let key = key.trim();
        if !valid_key(key) {
            warnings.push(Warning { line, message: "not a valid variable name" });
            continue;
        }
        match unquote(value.trim()) {
            Ok(value) => {
                if value.contains("${") || value.contains("$(") {
                    warnings.push(Warning { line, message: "interpolation is kept as text, not evaluated" });
                }
                vars.insert(key.to_string(), value);
            }
            Err(message) => warnings.push(Warning { line, message }),
        }
    }
    (vars, warnings)
}

// --------------------------------------------------------------- resolving --

/// Ordered by severity, so the worst piece of an expression decides its status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// Written as a plain value; the environment plays no part.
    Literal,
    /// Taken from the environment file.
    Env,
    /// Nothing written, so the value dbt parsed is shown as is.
    Parsed,
    /// Jinja that dbt-lens does not evaluate.
    Unevaluated,
    /// The file defines it, but as a placeholder rather than a real name.
    Placeholder,
    /// The file does not define a variable the config needs.
    Missing,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Cell {
    pub kind: Status,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub vars: Vec<String>,
    /// The value came from one branch of an `if`, picked by what dbt parsed
    /// rather than by evaluating the condition.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub branch: bool,
}

impl Cell {
    fn new(kind: Status) -> Cell {
        Cell { kind, vars: Vec::new(), branch: false }
    }
}

const SECRET_PREFIX: &str = "DBT_ENV_SECRET_";

/// dbt's own marker for a value that must never be rendered. The one guard that
/// applies to every path out of this module (0012).
fn is_secret(name: &str) -> bool {
    name.starts_with(SECRET_PREFIX)
}

/// Names that read as a credential rather than as a location. Applied only by
/// the vars route (0019), never by the location resolver: that one legitimately
/// reads names like `DBT_DB_RAW`, and a broad rule there would blank real
/// schema names and quietly wreck `agreement`.
///
/// Matched on underscore-delimited tokens, because `KEY` as a substring also
/// catches `PARTITION_KEY`, `DBT_UNIQUE_KEY` and `MONKEY`.
pub fn sensitive_name(name: &str) -> bool {
    const ALWAYS: [&str; 10] = [
        "PASSWORD", "PASSWD", "PWD", "PW", "SECRET", "TOKEN", "CREDENTIAL", "CREDENTIALS", "PRIVATE",
        "PASSPHRASE",
    ];
    const BEFORE_KEY: [&str; 6] = ["API", "ACCESS", "PRIVATE", "SECRET", "ENCRYPTION", "SIGNING"];
    let upper = name.to_ascii_uppercase();
    let tokens: Vec<&str> = upper.split('_').filter(|t| !t.is_empty()).collect();
    tokens.iter().enumerate().any(|(i, t)| {
        ALWAYS.contains(t) || (*t == "KEY" && i > 0 && BEFORE_KEY.contains(&tokens[i - 1]))
    })
}

/// Whether an expression's value came from the defaults written in its
/// `env_var()` calls rather than from the file. `all`, not `any`: an expression
/// reading two variables of which the file defines one is not "the default",
/// and saying so would be a claim the payload cannot support.
pub fn used_default(cell: &Cell, vars: &Vars) -> bool {
    cell.kind == Status::Env && !cell.vars.is_empty() && cell.vars.iter().all(|n| !vars.contains_key(n))
}

/// One environment variable by name, for the editor's `env_var()` hover. Same
/// secret guard as `substitute`, and the same vocabulary, so a caller cannot
/// reach a value through this door that the other one refuses.
pub fn lookup(name: &str, vars: &Vars) -> (String, Cell) {
    let mut cell = Cell::new(Status::Literal);
    cell.vars.push(name.to_string());
    if is_secret(name) {
        cell.kind = Status::Unevaluated;
        return (String::new(), cell);
    }
    match vars.get(name) {
        Some(v) => {
            cell.kind = if is_placeholder(v) { Status::Placeholder } else { Status::Env };
            (v.clone(), cell)
        }
        None => {
            cell.kind = Status::Missing;
            (String::new(), cell)
        }
    }
}

pub fn is_placeholder(value: &str) -> bool {
    let v = value.trim().to_ascii_lowercase();
    // `na` is left out on purpose: it is a plausible schema name.
    matches!(v.as_str(), "n/a" | "null" | "none" | "tbd" | "todo" | "changeme")
        || (v.len() > 2 && v.starts_with('<') && v.ends_with('>'))
}

/// Removes `{# ... #}` comments.
fn drop_comments(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("{#") {
        out.push_str(&rest[..start]);
        match rest[start..].find("#}") {
            Some(end) => rest = &rest[start + end + 2..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

/// `env_var('NAME')` or `env_var('NAME', 'default')`, nothing else. Returns the
/// name and the default, or None for any other expression.
fn env_var_call(inner: &str) -> Option<(String, Option<String>)> {
    let args = inner.trim().strip_prefix("env_var")?.trim_start().strip_prefix('(')?.strip_suffix(')')?;
    let mut parts = Vec::new();
    let mut rest = args.trim();
    while !rest.is_empty() {
        let quote = rest.chars().next().filter(|c| *c == '\'' || *c == '"')?;
        let close = rest[1..].find(quote)? + 1;
        parts.push(rest[1..close].to_string());
        rest = rest[close + 1..].trim_start();
        if let Some(after) = rest.strip_prefix(',') {
            rest = after.trim_start();
        } else if !rest.is_empty() {
            return None;
        }
    }
    match parts.as_slice() {
        [name] => Some((name.clone(), None)),
        [name, default] => Some((name.clone(), Some(default.clone()))),
        _ => None,
    }
}

/// Every `{{ ... }}` block of `expr` substituted from `vars`. The status is the
/// worst of its pieces.
fn substitute(expr: &str, vars: &Vars) -> (String, Cell) {
    let mut out = String::new();
    let mut cell = Cell::new(Status::Literal);
    let mut rest = expr;
    let raise = |cell: &mut Cell, kind: Status| {
        if kind > cell.kind {
            cell.kind = kind;
        }
    };
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let Some(len) = rest[start + 2..].find("}}") else {
            raise(&mut cell, Status::Unevaluated);
            return (String::new(), cell);
        };
        let inner = rest[start + 2..start + 2 + len].trim_start_matches('-').trim_end_matches('-');
        rest = &rest[start + 2 + len + 2..];

        match env_var_call(inner) {
            Some((name, _)) if is_secret(&name) => {
                raise(&mut cell, Status::Unevaluated);
            }
            Some((name, default)) => {
                let value = vars.get(&name).cloned().or(default);
                cell.vars.push(name);
                match value {
                    Some(v) => {
                        raise(&mut cell, if is_placeholder(&v) { Status::Placeholder } else { Status::Env });
                        out.push_str(&v);
                    }
                    None => raise(&mut cell, Status::Missing),
                }
            }
            None => raise(&mut cell, Status::Unevaluated),
        }
    }
    out.push_str(rest);

    let mut value = out.trim().to_string();
    // dbt drops a pair of literal quotes around the rendered name.
    if value.len() > 1 && value.starts_with('"') && value.ends_with('"') {
        value = value[1..value.len() - 1].to_string();
    }
    if matches!(cell.kind, Status::Missing | Status::Unevaluated) {
        value.clear();
    } else if value.is_empty() && cell.kind == Status::Env {
        cell.kind = Status::Placeholder;
    }
    cell.vars.dedup();
    (value, cell)
}

/// Splits `{% if %} A {% else %} B {% endif %}` into its two branches. Anything
/// with another shape returns None.
fn if_else(expr: &str) -> Option<(String, String)> {
    let mut tags = Vec::new();
    let mut texts = Vec::new();
    let mut rest = expr;
    while let Some(start) = rest.find("{%") {
        texts.push(rest[..start].to_string());
        let len = rest[start + 2..].find("%}")?;
        let tag = rest[start + 2..start + 2 + len].trim_matches('-').trim();
        tags.push(tag.split_whitespace().next().unwrap_or("").to_string());
        rest = &rest[start + 2 + len + 2..];
    }
    texts.push(rest.to_string());
    let shape: Vec<&str> = tags.iter().map(String::as_str).collect();
    if shape != ["if", "else", "endif"] || !texts[0].trim().is_empty() || !texts[3].trim().is_empty() {
        return None;
    }
    Some((texts[1].clone(), texts[2].clone()))
}

/// One warehouse identifier spelled two ways: case folded, one pair of quotes dropped.
pub(crate) fn same_ident(a: &str, b: &str) -> bool {
    let bare = |s: &str| {
        let s = s.trim();
        if s.len() > 1 && s.starts_with('"') && s.ends_with('"') { s[1..s.len() - 1].to_ascii_lowercase() } else { s.to_ascii_lowercase() }
    };
    bare(a) == bare(b)
}

/// One location value evaluated against one file. `parsed` is what dbt
/// rendered; it is used only when nothing was written, and as the hint for
/// which branch of an `if` dbt took.
pub fn resolve(written: &str, parsed: &str, vars: &Vars) -> (String, Cell) {
    let expr = drop_comments(written);
    if expr.trim().is_empty() {
        return if parsed.is_empty() {
            (String::new(), Cell::new(Status::Literal))
        } else {
            (parsed.to_string(), Cell::new(Status::Parsed))
        };
    }
    if !expr.contains("{{") && !expr.contains("{%") {
        return (expr.trim().to_string(), Cell::new(Status::Literal));
    }
    if !expr.contains("{%") {
        return substitute(&expr, vars);
    }

    let Some((then_part, else_part)) = if_else(&expr) else {
        return (String::new(), Cell::new(Status::Unevaluated));
    };
    // The condition is not evaluated: the branch dbt took is read off the
    // value it parsed, which works whenever the condition does not itself
    // depend on the environment.
    let else_literal = !else_part.contains("{{");
    let chosen = if else_literal && !parsed.is_empty() && same_ident(else_part.trim(), parsed) {
        else_part
    } else {
        match (then_part.contains("env_var"), else_part.contains("env_var")) {
            (true, false) => then_part,
            (false, true) => else_part,
            _ => return (String::new(), Cell::new(Status::Unevaluated)),
        }
    };
    let (value, mut cell) = substitute(&chosen, vars);
    cell.branch = true;
    (value, cell)
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct KeyStatus {
    pub database: Cell,
    pub schema: Cell,
    pub alias: Cell,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Resolution {
    pub place: Place,
    pub status: KeyStatus,
}

pub fn resolve_place(written: &Place, parsed: &Place, vars: &Vars) -> Resolution {
    let (database, db) = resolve(&written.database, &parsed.database, vars);
    let (schema, sc) = resolve(&written.schema, &parsed.schema, vars);
    let (alias, al) = resolve(&written.alias, &parsed.alias, vars);
    Resolution { place: Place { database, schema, alias }, status: KeyStatus { database: db, schema: sc, alias: al } }
}

/// Names of the env vars an expression reads.
pub fn var_names(written: &str) -> Vec<String> {
    let expr = drop_comments(written);
    let mut names = Vec::new();
    let mut rest = expr.as_str();
    while let Some(start) = rest.find("{{") {
        let Some(len) = rest[start + 2..].find("}}") else { break };
        let inner = rest[start + 2..start + 2 + len].trim_start_matches('-').trim_end_matches('-');
        if let Some((name, _)) = env_var_call(inner) {
            names.push(name);
        }
        rest = &rest[start + 2 + len + 2..];
    }
    names
}

#[derive(Debug, Default, Clone, PartialEq, serde::Serialize)]
pub struct Agreement {
    /// Keys whose value comes from the file.
    pub checked: usize,
    /// Of those, how many match what dbt parsed.
    pub equal: usize,
}

/// How far a file reproduces the manifest. The file dbt actually had loaded
/// should come out at 100%: anything less is a parsing bug or a stale manifest.
pub fn agreement<'a>(places: impl Iterator<Item = (&'a Place, &'a Place)>, vars: &Vars) -> Agreement {
    let mut result = Agreement::default();
    for (written, parsed) in places {
        let r = resolve_place(written, parsed, vars);
        for (value, cell, dbt) in [
            (&r.place.database, &r.status.database, &parsed.database),
            (&r.place.schema, &r.status.schema, &parsed.schema),
            (&r.place.alias, &r.status.alias, &parsed.alias),
        ] {
            if cell.kind == Status::Env && !dbt.is_empty() {
                result.checked += 1;
                if same_ident(value, dbt) {
                    result.equal += 1;
                }
            }
        }
    }
    result
}

// ------------------------------------------------------------- discovering --

pub struct EnvFile {
    /// File name, which is also the key used everywhere else: ".env.uat".
    pub file: String,
    /// Uppercased suffix, "LOCAL" for a bare `.env`. Suffixes never collide.
    pub auto_name: String,
    /// `DBT_TARGET` from the file, shown next to the name as a cross-check.
    pub target: String,
    /// Why the file is hidden unless the user says otherwise.
    pub auto_hidden: Option<&'static str>,
    pub vars: Vars,
    pub warnings: Vec<Warning>,
}

fn name_hidden_reason(file: &str) -> Option<&'static str> {
    let lower = file.to_ascii_lowercase();
    if [".bak", ".orig", ".old", "~", ".swp"].iter().any(|s| lower.ends_with(s)) {
        return Some("backup file");
    }
    let suffix = lower.rsplit('.').next().unwrap_or("");
    if ["example", "sample", "template", "dist"].contains(&suffix) {
        return Some("template file");
    }
    None
}

/// `.env` and `.env.*` files in the project root. Directories are skipped (a
/// Python virtualenv is often named `.env`) and so is `.envrc`.
pub fn discover(root: &Path) -> Vec<EnvFile> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else { return found };
    for entry in entries.flatten() {
        let file = entry.file_name().to_string_lossy().into_owned();
        if file != ".env" && !file.starts_with(".env.") {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        if !meta.is_file() || meta.len() > MAX_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let (vars, warnings) = parse(&decode(&bytes));
        found.push(EnvFile {
            auto_name: match file.strip_prefix(".env.") {
                Some(suffix) => suffix.to_ascii_uppercase(),
                None => "LOCAL".to_string(),
            },
            target: vars.get("DBT_TARGET").cloned().unwrap_or_default(),
            auto_hidden: name_hidden_reason(&file),
            file,
            vars,
            warnings,
        });
    }
    found.sort_by(|a, b| a.file.cmp(&b.file));
    found
}

/// Every discovered file's resolution of one node, keyed by file name.
pub fn resolve_all(files: &[EnvFile], written: &Place, parsed: &Place) -> BTreeMap<String, Resolution> {
    files.iter().map(|f| (f.file.clone(), resolve_place(written, parsed, &f.vars))).collect()
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct RefVar {
    pub var: String,
    /// Nodes whose location reads this variable.
    pub nodes: usize,
}

/// Env vars read by location config across the project, most used first.
pub fn referenced(places: &[(&Place, &Place)]) -> Vec<RefVar> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for (written, _) in places {
        let mut names = var_names(&written.database);
        names.extend(var_names(&written.schema));
        names.extend(var_names(&written.alias));
        names.sort();
        names.dedup();
        for name in names {
            *counts.entry(name).or_insert(0) += 1;
        }
    }
    let mut out: Vec<RefVar> = counts.into_iter().map(|(var, nodes)| RefVar { var, nodes }).collect();
    out.sort_by(|a, b| b.nodes.cmp(&a.nodes).then_with(|| a.var.cmp(&b.var)));
    out
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Coverage {
    /// Referenced variables the file defines.
    pub defined: usize,
    /// Referenced variables it does not define. Names only, never values.
    pub missing: Vec<String>,
    /// Referenced variables it defines with a placeholder. Names only.
    pub placeholders: Vec<String>,
}

pub fn coverage(file: &EnvFile, referenced: &[RefVar]) -> Coverage {
    let mut c = Coverage { defined: 0, missing: Vec::new(), placeholders: Vec::new() };
    for r in referenced {
        match file.vars.get(&r.var) {
            Some(value) => {
                c.defined += 1;
                if is_placeholder(value) || value.trim().is_empty() {
                    c.placeholders.push(r.var.clone());
                }
            }
            None => c.missing.push(r.var.clone()),
        }
    }
    c
}

/// The reason a file is hidden before the user has any say: its name marks it
/// as a template or a backup, or it defines none of the variables in use.
pub fn auto_hidden(file: &EnvFile, coverage: &Coverage, referenced: &[RefVar]) -> Option<&'static str> {
    file.auto_hidden.or_else(|| {
        (!referenced.is_empty() && coverage.defined == 0).then_some("defines none of the variables your config reads")
    })
}

/// A `DBT_TARGET` that disagrees with the file suffix, which is usually a file
/// copied from another environment and not fully edited.
pub fn target_mismatch(file: &EnvFile) -> bool {
    match file.file.strip_prefix(".env.") {
        Some(suffix) if !file.target.is_empty() => !suffix.eq_ignore_ascii_case(&file.target),
        _ => false,
    }
}

// -------------------------------------------------------------------- tests --

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Vars {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    // decode

    #[test]
    fn decode_strips_utf8_bom() {
        assert_eq!(decode(b"\xEF\xBB\xBFA=1"), "A=1");
    }

    #[test]
    fn decode_reads_utf16le_with_bom() {
        let bytes: Vec<u8> = [0xFF, 0xFE].into_iter().chain("A=1".encode_utf16().flat_map(|u| u.to_le_bytes())).collect();
        assert_eq!(decode(&bytes), "A=1");
    }

    #[test]
    fn decode_reads_utf16be_with_bom() {
        let bytes: Vec<u8> = [0xFE, 0xFF].into_iter().chain("A=1".encode_utf16().flat_map(|u| u.to_be_bytes())).collect();
        assert_eq!(decode(&bytes), "A=1");
    }

    // parse

    #[test]
    fn parse_handles_crlf_comments_and_blanks() {
        let (v, w) = parse("# header\r\n\r\nA=1\r\nB=two\r\n");
        assert_eq!(v, vars(&[("A", "1"), ("B", "two")]));
        assert!(w.is_empty());
    }

    #[test]
    fn parse_accepts_export_and_spaces_around_the_value() {
        let (v, _) = parse("export A = hello \n");
        assert_eq!(v.get("A").map(String::as_str), Some("hello"));
    }

    #[test]
    fn parse_keeps_double_quotes_inside_a_single_quoted_json_value() {
        let (v, w) = parse(r#"OPTS='{"error": ["NoNodesForSelectionCriteria"], "warn": "all"}'"#);
        assert_eq!(v.get("OPTS").map(String::as_str), Some(r#"{"error": ["NoNodesForSelectionCriteria"], "warn": "all"}"#));
        assert!(w.is_empty());
    }

    #[test]
    fn parse_unescapes_only_quote_and_backslash_in_double_quotes() {
        let (v, _) = parse(r#"A="say \"hi\" \\ keep \n""#);
        assert_eq!(v.get("A").map(String::as_str), Some(r#"say "hi" \ keep \n"#));
    }

    #[test]
    fn parse_cuts_an_inline_comment_only_when_unquoted() {
        let (v, _) = parse("A=db_name # the database\nB=\"db # not a comment\"");
        assert_eq!(v.get("A").map(String::as_str), Some("db_name"));
        assert_eq!(v.get("B").map(String::as_str), Some("db # not a comment"));
    }

    #[test]
    fn parse_keeps_an_equals_sign_inside_the_value() {
        let (v, _) = parse("URL=a=b=c");
        assert_eq!(v.get("URL").map(String::as_str), Some("a=b=c"));
    }

    #[test]
    fn parse_lets_the_last_duplicate_win() {
        let (v, _) = parse("A=1\nA=2");
        assert_eq!(v.get("A").map(String::as_str), Some("2"));
    }

    #[test]
    fn parse_warns_without_ever_echoing_a_value() {
        let (v, w) = parse("no equals here\n9BAD=x\nA='unterminated\nB=${OTHER}/x");
        assert_eq!(w.iter().map(|w| w.line).collect::<Vec<_>>(), vec![1, 2, 3, 4]);
        assert!(w.iter().all(|w| !w.message.contains("unterminated'") && !w.message.contains("OTHER")));
        assert_eq!(v.get("B").map(String::as_str), Some("${OTHER}/x"));
        assert!(!v.contains_key("A"));
    }

    // resolve

    #[test]
    fn resolve_literal() {
        assert_eq!(resolve("marts", "marts", &Vars::new()), ("marts".into(), Cell::new(Status::Literal)));
    }

    #[test]
    fn resolve_nothing_written_shows_parsed() {
        let (value, cell) = resolve("", "orders", &Vars::new());
        assert_eq!((value.as_str(), cell.kind), ("orders", Status::Parsed));
    }

    #[test]
    fn resolve_env_var_from_the_file() {
        let (value, cell) = resolve("{{ env_var('DBT_DB_MART') }}", "MART_CI", &vars(&[("DBT_DB_MART", "MART_UAT")]));
        assert_eq!(value, "MART_UAT");
        assert_eq!(cell.kind, Status::Env);
        assert_eq!(cell.vars, vec!["DBT_DB_MART".to_string()]);
    }

    #[test]
    fn resolve_whitespace_control_and_double_quoted_name() {
        let (value, cell) = resolve(r#"{{- env_var("DBT_DB_MART") -}}"#, "", &vars(&[("DBT_DB_MART", "M")]));
        assert_eq!((value.as_str(), cell.kind), ("M", Status::Env));
    }

    #[test]
    fn resolve_missing_variable() {
        let (value, cell) = resolve("{{ env_var('DBT_DB_MART') }}", "MART_CI", &Vars::new());
        assert_eq!((value.as_str(), cell.kind), ("", Status::Missing));
        assert_eq!(cell.vars, vec!["DBT_DB_MART".to_string()]);
    }

    #[test]
    fn resolve_uses_a_literal_default() {
        let (value, cell) = resolve("{{ env_var('DBT_DB_MART', 'FALLBACK_DB') }}", "", &Vars::new());
        assert_eq!((value.as_str(), cell.kind), ("FALLBACK_DB", Status::Env));
    }

    #[test]
    fn resolve_flags_a_placeholder_but_not_na() {
        let (value, cell) = resolve("{{ env_var('DBT_DB_RAW') }}", "", &vars(&[("DBT_DB_RAW", "N/A")]));
        assert_eq!((value.as_str(), cell.kind), ("N/A", Status::Placeholder));
        let (_, na) = resolve("{{ env_var('REGION') }}", "", &vars(&[("REGION", "NA")]));
        assert_eq!(na.kind, Status::Env);
    }

    #[test]
    fn resolve_placeholder_inside_a_concatenation_is_the_worst_piece() {
        let (_, cell) = resolve("{{ env_var('A') }}_{{ env_var('B') }}", "", &vars(&[("A", "DB"), ("B", "TODO")]));
        assert_eq!(cell.kind, Status::Placeholder);
        assert_eq!(cell.vars, vec!["A".to_string(), "B".to_string()]);
    }

    #[test]
    fn resolve_empty_suffix_is_fine_but_an_empty_whole_is_a_placeholder() {
        let (value, cell) = resolve("{{ env_var('A') }}{{ env_var('B') }}", "", &vars(&[("A", "DB"), ("B", "")]));
        assert_eq!((value.as_str(), cell.kind), ("DB", Status::Env));
        let (_, empty) = resolve("{{ env_var('A') }}", "", &vars(&[("A", "")]));
        assert_eq!(empty.kind, Status::Placeholder);
    }

    #[test]
    fn resolve_anything_but_env_var_is_unevaluated() {
        for expr in ["{{ env_var('A') | upper }}", "{{ target.name }}", "{{ var('x') }}", "{{ env_var('A') ~ '_X' }}"] {
            let (value, cell) = resolve(expr, "SOMETHING", &vars(&[("A", "DB")]));
            assert_eq!((value.as_str(), cell.kind), ("", Status::Unevaluated), "{expr}");
        }
    }

    #[test]
    fn resolve_ignores_jinja_comments() {
        let (value, cell) = resolve("{# pick the mart #}{{ env_var('A') }}", "", &vars(&[("A", "DB")]));
        assert_eq!((value.as_str(), cell.kind), ("DB", Status::Env));
    }

    #[test]
    fn used_default_is_all_not_any() {
        let one = vars(&[("DBT_A", "from_file")]);
        let (_, mixed) = resolve("{{ env_var('DBT_A') }}-{{ env_var('DBT_B', 'd') }}", "", &one);
        assert!(!used_default(&mixed, &one), "one name came from the file, so this is not the default");
        let (_, both) = resolve("{{ env_var('DBT_X', 'd') }}-{{ env_var('DBT_Y', 'e') }}", "", &vars(&[]));
        assert!(used_default(&both, &vars(&[])));
        let (_, from_file) = resolve("{{ env_var('DBT_A') }}", "", &one);
        assert!(!used_default(&from_file, &one));
    }

    #[test]
    fn lookup_never_returns_a_secret() {
        let (value, cell) = lookup("DBT_ENV_SECRET_PASSWORD", &vars(&[("DBT_ENV_SECRET_PASSWORD", "hunter2")]));
        assert_eq!((value.as_str(), cell.kind), ("", Status::Unevaluated));
    }

    #[test]
    fn lookup_reports_a_missing_name_without_inventing_one() {
        let (value, cell) = lookup("DBT_ABSENT", &vars(&[]));
        assert_eq!((value.as_str(), cell.kind), ("", Status::Missing));
        assert_eq!(cell.vars, ["DBT_ABSENT"]);
    }

    #[test]
    fn lookup_flags_a_placeholder() {
        let (_, cell) = lookup("DBT_DB", &vars(&[("DBT_DB", "TBD")]));
        assert_eq!(cell.kind, Status::Placeholder);
    }

    #[test]
    fn sensitive_name_catches_credentials() {
        for name in ["SNOWFLAKE_PASSWORD", "DBT_API_KEY", "MY_TOKEN", "AZURE_CLIENT_SECRET",
                     "svc_passwd", "DB_CREDENTIALS", "SSH_PRIVATE_KEY", "A_PASSPHRASE",
                     "SF_PW", "DB_PWD"] {
            assert!(sensitive_name(name), "{name} should be treated as sensitive");
        }
    }

    #[test]
    fn sensitive_name_leaves_ordinary_config_alone() {
        for name in ["DBT_UNIQUE_KEY", "PARTITION_KEY", "SORT_KEY", "MERGE_KEY", "KEYSTONE_SCHEMA",
                     "MONKEY", "DBT_DB_RAW", "DBT_TARGET", "KEY", "POWER_BI_URL", "PWA_HOST"] {
            assert!(!sensitive_name(name), "{name} should not be treated as sensitive");
        }
    }

    #[test]
    fn resolve_never_substitutes_a_secret() {
        let (value, cell) = resolve("{{ env_var('DBT_ENV_SECRET_PASSWORD') }}", "", &vars(&[("DBT_ENV_SECRET_PASSWORD", "hunter2")]));
        assert_eq!((value.as_str(), cell.kind), ("", Status::Unevaluated));
    }

    #[test]
    fn resolve_strips_literal_quotes_like_dbt() {
        let (value, _) = resolve(r#""{{ env_var('A') }}""#, "", &vars(&[("A", "RAW_DB")]));
        assert_eq!(value, "RAW_DB");
    }

    const BRANCHY: &str = r#"{%- if var('layer') in ("SRC_", "") -%} "{{ env_var('DBT_DB_RAW') }}" {%- else -%} unknown_db {%- endif -%}"#;

    #[test]
    fn resolve_if_picks_the_env_branch_when_dbt_did_not_take_else() {
        let (value, cell) = resolve(BRANCHY, "RAW_CI", &vars(&[("DBT_DB_RAW", "RAW_UAT")]));
        assert_eq!((value.as_str(), cell.kind, cell.branch), ("RAW_UAT", Status::Env, true));
    }

    #[test]
    fn resolve_if_follows_dbt_into_a_literal_else() {
        let (value, cell) = resolve(BRANCHY, "unknown_db", &vars(&[("DBT_DB_RAW", "RAW_UAT")]));
        assert_eq!((value.as_str(), cell.kind, cell.branch), ("unknown_db", Status::Literal, true));
    }

    #[test]
    fn resolve_if_with_any_other_shape_is_unevaluated() {
        let nested = "{% if a %}{{ env_var('X') }}{% elif b %}y{% else %}z{% endif %}";
        assert_eq!(resolve(nested, "y", &Vars::new()).1.kind, Status::Unevaluated);
    }

    // var_names, agreement

    #[test]
    fn var_names_lists_every_env_var() {
        assert_eq!(var_names("{{ env_var('A') }}_{{- env_var(\"B\", 'd') -}}"), vec!["A".to_string(), "B".to_string()]);
        assert!(var_names("plain").is_empty());
    }

    fn place(database: &str, schema: &str) -> Place {
        Place { database: database.into(), schema: schema.into(), alias: String::new() }
    }

    #[test]
    fn agreement_counts_only_env_keys() {
        let written = [place("{{ env_var('A') }}", "marts"), place("{{ env_var('B') }}", "raw")];
        let parsed = [place("DB_A", "marts"), place("db_b", "raw")];
        let ci = vars(&[("A", "DB_A"), ("B", "DB_B")]);
        assert_eq!(agreement(written.iter().zip(parsed.iter()), &ci), Agreement { checked: 2, equal: 2 });
        let uat = vars(&[("A", "DB_A_UAT"), ("B", "DB_B")]);
        assert_eq!(agreement(written.iter().zip(parsed.iter()), &uat), Agreement { checked: 2, equal: 1 });
    }

    // discover

    #[test]
    fn discover_names_hides_and_skips_correctly() {
        let dir = std::env::temp_dir().join(format!("dbt-lens-envs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".env.venvlike")).unwrap(); // a directory, not a file
        std::fs::write(dir.join(".env"), "A=1").unwrap();
        std::fs::write(dir.join(".env.uat"), "DBT_TARGET=uat\nA=2").unwrap();
        std::fs::write(dir.join(".env.example"), "A=").unwrap();
        std::fs::write(dir.join(".env.uat.bak"), "A=3").unwrap();
        std::fs::write(dir.join(".envrc"), "export A=4").unwrap();

        let files = discover(&dir);
        let summary: Vec<(&str, &str, &str, Option<&str>)> =
            files.iter().map(|f| (f.file.as_str(), f.auto_name.as_str(), f.target.as_str(), f.auto_hidden)).collect();
        assert_eq!(
            summary,
            vec![
                (".env", "LOCAL", "", None),
                (".env.example", "EXAMPLE", "", Some("template file")),
                (".env.uat", "UAT", "uat", None),
                (".env.uat.bak", "UAT.BAK", "", Some("backup file")),
            ]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
