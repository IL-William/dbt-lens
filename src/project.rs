//! `dbt_project.yml`: the `vars:` block, and nothing else in the file.
//!
//! The manifest holds the merged YAML for everything else, but it does not hold
//! project vars at all, so this is the one place they can be read (0018).
//!
//! The scanner covers the shapes that actually appear in a `vars:` block and
//! reports every line it could not read, with a line number and a fixed
//! message. It never guesses: a value that is silently wrong is worse than a
//! value that is visibly absent. Like `envs::Warning`, an `Unparsed` carries no
//! text from the file, so nothing can escape through an error path.
//!
//! `files::is_dbt_project` is the other place that knows this file exists; it
//! only checks for it at startup.

use std::path::Path;

/// A project file larger than this is not one anyone maintains by hand.
const MAX_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ProjectVar {
    pub name: String,
    pub line: usize,
    /// The value as written, quotes removed and any trailing comment stripped.
    /// Jinja is kept as text: nothing here evaluates it.
    pub raw: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub list: Option<Vec<String>>,
    /// `raw` holds Jinja, so it needs the env scanner to mean anything (0009).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub jinja: bool,
    /// Written with no value at all. That is a real dbt var whose value is null,
    /// not a line that could not be read, and projects use it on purpose to mean
    /// "unset".
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub null: bool,
}

/// A package-scoped block, `vars:` -> `<package>:` -> its own vars. Reported
/// rather than flattened: a package scope shadows the global one for that
/// package, and pretending otherwise would show the wrong value.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct PackageVars {
    pub package: String,
    pub line: usize,
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Unparsed {
    pub line: usize,
    pub message: &'static str,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct ProjectVars {
    /// Whether a `vars:` block exists at all, which is not the same as an empty one.
    pub found: bool,
    pub vars: Vec<ProjectVar>,
    pub packages: Vec<PackageVars>,
    pub unparsed: Vec<Unparsed>,
}

/// Leading spaces, or None when the indentation contains a tab. YAML forbids a
/// tab there, and misreading the nesting is worse than refusing the line.
fn indent_of(line: &str) -> Option<usize> {
    let n = line.len() - line.trim_start_matches(' ').len();
    if line[n..].starts_with('\t') {
        return None;
    }
    Some(n)
}

fn skippable(line: &str) -> bool {
    let t = line.trim();
    t.is_empty() || t.starts_with('#')
}

/// Splits `key: value` at the first `:` outside quotes. YAML only starts a
/// mapping when the colon is followed by a space or ends the line, so `a:b` is
/// a scalar and is refused rather than silently split.
fn split_key(s: &str) -> Option<(String, &str)> {
    let b = s.as_bytes();
    let mut quote: Option<u8> = None;
    for i in 0..b.len() {
        let c = b[i];
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                }
            }
            None => {
                if c == b'\'' || c == b'"' {
                    quote = Some(c);
                } else if c == b':' && (i + 1 == b.len() || b[i + 1] == b' ' || b[i + 1] == b'\t') {
                    let key = s[..i].trim();
                    let key = key.strip_prefix('"').and_then(|k| k.strip_suffix('"'))
                        .or_else(|| key.strip_prefix('\'').and_then(|k| k.strip_suffix('\'')))
                        .unwrap_or(key);
                    return Some((key.to_string(), &s[i + 1..]));
                }
            }
        }
    }
    None
}

enum Value {
    Scalar(String),
    List(Vec<String>),
    Bad(&'static str),
}

/// A quoted scalar, up to its closing quote. `''` inside single quotes and the
/// usual backslash escapes inside double quotes are honoured; anything after
/// the closing quote other than a comment is refused.
fn quoted(v: &str) -> Value {
    let q = v.as_bytes()[0] as char;
    let mut out = String::new();
    let mut it = v[1..].char_indices();
    while let Some((i, c)) = it.next() {
        if q == '"' && c == '\\' {
            match it.next() {
                Some((_, n)) => {
                    out.push(match n {
                        'n' => '\n',
                        't' => '\t',
                        other => other,
                    });
                    continue;
                }
                None => return Value::Bad("unterminated quote"),
            }
        }
        if c == q {
            let after_at = 1 + i + 1;
            if q == '\'' && v[after_at..].starts_with('\'') {
                out.push('\'');
                it.next();
                continue;
            }
            let after = v[after_at..].trim();
            if after.is_empty() || after.starts_with('#') {
                return Value::Scalar(out);
            }
            return Value::Bad("text after the closing quote is not read");
        }
        out.push(c);
    }
    Value::Bad("unterminated quote")
}

/// A flow sequence, `['a', "b", c]`. One level only: a nested collection is
/// refused rather than flattened.
fn flow_list(v: &str) -> Value {
    let Some(close) = v.rfind(']') else {
        return Value::Bad("a flow sequence with no closing bracket");
    };
    let after = v[close + 1..].trim();
    if !after.is_empty() && !after.starts_with('#') {
        return Value::Bad("text after the closing bracket is not read");
    }
    let inner = &v[1..close];
    let b = inner.as_bytes();
    let mut items = Vec::new();
    let mut quote: Option<u8> = None;
    let mut start = 0;
    for i in 0..b.len() {
        let c = b[i];
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                }
            }
            None => match c {
                b'\'' | b'"' => quote = Some(c),
                b'[' | b'{' => return Value::Bad("a nested flow collection is not read"),
                b',' => {
                    items.push(&inner[start..i]);
                    start = i + 1;
                }
                _ => {}
            },
        }
    }
    items.push(&inner[start..]);

    let mut out = Vec::new();
    for item in items {
        let t = item.trim();
        if t.is_empty() {
            continue;
        }
        match t.as_bytes()[0] {
            b'\'' | b'"' => match quoted(t) {
                Value::Scalar(s) => out.push(s),
                _ => return Value::Bad("a quoted item in the sequence is not read"),
            },
            _ => out.push(t.to_string()),
        }
    }
    Value::List(out)
}

/// The value half of a `key: value` line.
fn parse_value(v: &str) -> Value {
    let v = v.trim();
    match v.as_bytes()[0] {
        b'[' => flow_list(v),
        b'{' => Value::Bad("a flow mapping is not read"),
        b'|' | b'>' => Value::Bad("a block scalar is not read"),
        b'&' => Value::Bad("an anchor is not read"),
        b'*' => Value::Bad("an alias is not read"),
        b'\'' | b'"' => quoted(v),
        _ => {
            // A `#` only ends a plain scalar when a space or tab precedes it,
            // the same rule `envs::unquote` uses, so `EXT_`, `Europe/London`
            // and `current_timestamp()` survive while `1  # widen` does not.
            let end = [v.find(" #"), v.find("\t#")].into_iter().flatten().min().unwrap_or(v.len());
            Value::Scalar(v[..end].trim_end().to_string())
        }
    }
}

/// The project's `vars:` block. Only a `vars:` at indentation 0 counts: one
/// nested under `models:` is a per-model config, not a project var.
pub fn scan(text: &str) -> ProjectVars {
    let mut out = ProjectVars::default();
    let lines: Vec<&str> = text.lines().collect();

    let Some(head) = lines.iter().position(|l| l.trim() == "vars:" && indent_of(l) == Some(0)) else {
        return out;
    };
    out.found = true;

    // The block's indentation is whatever its first real line uses, never a
    // hardcoded two: packages in the wild indent by four.
    let first = lines[head + 1..].iter().position(|l| !skippable(l)).map(|i| head + 1 + i);
    let Some(first) = first else { return out };
    let Some(block) = indent_of(lines[first]) else {
        out.unparsed.push(Unparsed { line: first + 1, message: "tabs are not valid YAML indentation" });
        return out;
    };
    if block == 0 {
        return out;
    }

    let mut j = first;
    while j < lines.len() {
        let line = lines[j];
        // A blank line, or a comment at any indentation, continues the block.
        if skippable(line) {
            j += 1;
            continue;
        }
        let Some(ind) = indent_of(line) else {
            out.unparsed.push(Unparsed { line: j + 1, message: "tabs are not valid YAML indentation" });
            j += 1;
            continue;
        };
        if ind == 0 {
            break;
        }
        if ind != block {
            out.unparsed.push(Unparsed { line: j + 1, message: "indented differently from the rest of the block" });
            j += 1;
            continue;
        }
        let Some((name, rest)) = split_key(&line[ind..]) else {
            out.unparsed.push(Unparsed { line: j + 1, message: "not a key and a value" });
            j += 1;
            continue;
        };
        if name == "<<" {
            out.unparsed.push(Unparsed { line: j + 1, message: "a merge key is not read" });
            j += 1;
            continue;
        }

        if rest.trim().is_empty() {
            // A block sequence, a package scope, or a null. Collect the nested
            // lines first: which of the three it is depends on their shape.
            let mut k = j + 1;
            let mut nested: Vec<&str> = Vec::new();
            while k < lines.len() {
                if skippable(lines[k]) {
                    k += 1;
                    continue;
                }
                match indent_of(lines[k]) {
                    Some(i) if i > block => {
                        nested.push(lines[k].trim());
                        k += 1;
                    }
                    _ => break,
                }
            }
            let count = nested.len();

            // A single `-` makes it a sequence, not a package scope: only
            // `key: value` lines all the way down are a scope. A list is an
            // ordinary var value and the commonest way to write one, so it is
            // read; anything richer than plain items is reported rather than
            // guessed at.
            if nested.iter().any(|l| l.starts_with('-')) {
                let mut items = Vec::new();
                let mut bad = !nested.iter().all(|l| l.starts_with('-'));
                for line in nested.iter().take_while(|_| !bad) {
                    let item = line[1..].trim();
                    if item.is_empty() {
                        bad = true;
                        break;
                    }
                    match parse_value(item) {
                        Value::Scalar(v) => items.push(v),
                        _ => {
                            bad = true;
                            break;
                        }
                    }
                }
                if bad {
                    out.unparsed.push(Unparsed { line: j + 1, message: "a sequence of anything but plain items is not read" });
                } else {
                    push_var(&mut out, ProjectVar {
                        name,
                        line: j + 1,
                        raw: items.join(", "),
                        list: Some(items),
                        jinja: false,
                        null: false,
                    });
                }
                j = k;
                continue;
            }

            if count == 0 {
                push_var(&mut out, ProjectVar {
                    name,
                    line: j + 1,
                    raw: String::new(),
                    list: None,
                    jinja: false,
                    null: true,
                });
            } else {
                out.packages.push(PackageVars { package: name, line: j + 1, count });
            }
            j = k;
            continue;
        }

        match parse_value(rest) {
            Value::Bad(message) => out.unparsed.push(Unparsed { line: j + 1, message }),
            Value::List(items) => push_var(&mut out, ProjectVar {
                name,
                line: j + 1,
                raw: items.join(", "),
                list: Some(items),
                jinja: false,
                null: false,
            }),
            Value::Scalar(s) => {
                let jinja = s.contains("{{") || s.contains("{%");
                push_var(&mut out, ProjectVar { name, line: j + 1, raw: s, list: None, jinja, null: false });
            }
        }
        j += 1;
    }
    out
}

/// dbt would refuse a duplicate key outright. Being lenient is more useful than
/// refusing the whole block, but it is never silent.
fn push_var(out: &mut ProjectVars, var: ProjectVar) {
    if let Some(prev) = out.vars.iter().position(|v| v.name == var.name) {
        out.unparsed.push(Unparsed { line: var.line, message: "a duplicate key, the last one wins" });
        out.vars.remove(prev);
    }
    out.vars.push(var);
}

pub fn read(root: &Path) -> ProjectVars {
    let path = root.join("dbt_project.yml");
    let Ok(meta) = std::fs::metadata(&path) else {
        return ProjectVars::default();
    };
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return ProjectVars::default();
    }
    match std::fs::read(&path) {
        Ok(bytes) => scan(&crate::envs::decode(&bytes)),
        Err(_) => ProjectVars::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(p: &ProjectVars) -> Vec<&str> {
        p.vars.iter().map(|v| v.name.as_str()).collect()
    }
    fn raw<'a>(p: &'a ProjectVars, name: &str) -> &'a str {
        p.vars.iter().find(|v| v.name == name).map(|v| v.raw.as_str()).unwrap_or("<missing>")
    }

    #[test]
    fn flat_keys_at_two_and_four_space_indent() {
        let two = scan("vars:\n  alpha: 1\n  beta: two\n");
        assert_eq!(names(&two), ["alpha", "beta"]);
        let four = scan("vars:\n    alpha: 1\n    beta: two\n");
        assert_eq!(names(&four), ["alpha", "beta"]);
        assert!(four.unparsed.is_empty());
    }

    #[test]
    fn unquoted_scalars_keep_their_shape() {
        let p = scan(concat!(
            "vars:\n",
            "  zone: Europe/London\n",
            "  lag: 60 minutes\n",
            "  stamp: current_timestamp()\n",
            "  prefix: EXT_\n",
        ));
        assert_eq!(raw(&p, "zone"), "Europe/London");
        assert_eq!(raw(&p, "lag"), "60 minutes");
        assert_eq!(raw(&p, "stamp"), "current_timestamp()");
        assert_eq!(raw(&p, "prefix"), "EXT_");
    }

    #[test]
    fn an_inline_comment_needs_a_space_before_the_hash() {
        let p = scan("vars:\n  days: 1   # widen as needed\n  tag: a#b\n");
        assert_eq!(raw(&p, "days"), "1");
        assert_eq!(raw(&p, "tag"), "a#b");
    }

    #[test]
    fn a_hash_inside_quotes_is_not_a_comment() {
        let p = scan("vars:\n  label: 'lot # 4'\n");
        assert_eq!(raw(&p, "label"), "lot # 4");
    }

    #[test]
    fn a_comment_line_does_not_end_the_block() {
        let p = scan(concat!(
            "vars:\n",
            "  alpha: 1\n",
            "  ## a section heading\n",
            " # a comment indented by one, as people write them\n",
            "  beta: 2\n",
        ));
        assert_eq!(names(&p), ["alpha", "beta"]);
        assert!(p.unparsed.is_empty());
    }

    #[test]
    fn a_blank_line_does_not_end_the_block() {
        let p = scan("vars:\n  alpha: 1\n\n  beta: 2\n");
        assert_eq!(names(&p), ["alpha", "beta"]);
    }

    #[test]
    fn the_block_ends_at_the_next_top_level_key() {
        let p = scan("vars:\n  alpha: 1\nquoting:\n  database: false\n");
        assert_eq!(names(&p), ["alpha"]);
        assert!(p.unparsed.is_empty());
    }

    #[test]
    fn the_block_ends_at_end_of_file() {
        let p = scan("vars:\n  alpha: 1");
        assert_eq!(names(&p), ["alpha"]);
    }

    #[test]
    fn a_flow_sequence_becomes_a_list() {
        let p = scan("vars:\n  codes: ['GBP', \"USD\" , EUR]\n");
        let v = &p.vars[0];
        assert_eq!(v.list.as_deref(), Some(["GBP".to_string(), "USD".to_string(), "EUR".to_string()].as_slice()));
        assert_eq!(v.raw, "GBP, USD, EUR");
    }

    #[test]
    fn a_block_sequence_is_a_list_not_a_package() {
        // The commonest way to write a list var, and it must not be mistaken
        // for a package scope, which would make the var vanish silently.
        let p = scan("vars:\n  regions:\n    - EU\n    - 'US'\n  alpha: 1\n");
        assert_eq!(names(&p), ["regions", "alpha"]);
        assert_eq!(
            p.vars[0].list.as_deref(),
            Some(["EU".to_string(), "US".to_string()].as_slice())
        );
        assert_eq!(raw(&p, "regions"), "EU, US");
        assert!(p.packages.is_empty());
        assert!(p.unparsed.is_empty());
    }

    #[test]
    fn a_block_sequence_with_an_inline_comment_keeps_the_value() {
        let p = scan("vars:\n  regions:\n    - EU   # primary\n");
        assert_eq!(p.vars[0].list.as_deref(), Some(["EU".to_string()].as_slice()));
    }

    #[test]
    fn a_sequence_of_mappings_is_reported_not_guessed() {
        let p = scan("vars:\n  rules:\n    - name: a\n      to: b\n");
        assert!(p.vars.is_empty());
        assert_eq!(p.unparsed.len(), 1);
    }

    #[test]
    fn a_nested_flow_collection_is_unparsed() {
        let p = scan("vars:\n  nested: [[1, 2], 3]\n");
        assert!(p.vars.is_empty());
        assert_eq!(p.unparsed.len(), 1);
    }

    #[test]
    fn a_jinja_value_is_kept_as_text() {
        let p = scan("vars:\n  cutoff: \"{{ env_var('DBT_CUTOFF', '1900-01-01') }}\"\n");
        assert_eq!(raw(&p, "cutoff"), "{{ env_var('DBT_CUTOFF', '1900-01-01') }}");
        assert!(p.vars[0].jinja);
    }

    #[test]
    fn a_plain_value_is_not_flagged_as_jinja() {
        let p = scan("vars:\n  prefix: EXT_\n");
        assert!(!p.vars[0].jinja);
    }

    #[test]
    fn a_quoted_key_may_contain_a_colon() {
        let p = scan("vars:\n  \"pkg:zone\": 'America/Los_Angeles'\n");
        assert_eq!(names(&p), ["pkg:zone"]);
        assert_eq!(raw(&p, "pkg:zone"), "America/Los_Angeles");
    }

    #[test]
    fn a_key_with_no_value_is_a_null_var_not_an_error() {
        // Projects write this on purpose to mean "unset", and var() then returns
        // None, so it is a var rather than a line that could not be read.
        let p = scan("vars:\n  lookback_days:\n  alpha: 1\n");
        assert_eq!(names(&p), ["lookback_days", "alpha"]);
        assert!(p.vars[0].null);
        assert_eq!(raw(&p, "lookback_days"), "");
        assert!(p.unparsed.is_empty());
    }

    #[test]
    fn a_key_with_no_space_after_the_colon_is_not_a_mapping() {
        let p = scan("vars:\n  alpha:1\n");
        assert!(p.vars.is_empty());
        assert_eq!(p.unparsed[0].message, "not a key and a value");
    }

    #[test]
    fn package_scoped_vars_are_reported_not_flattened() {
        let p = scan("vars:\n  alpha: 1\n  my_pkg:\n    inner: 2\n    other: 3\n  beta: 4\n");
        assert_eq!(names(&p), ["alpha", "beta"]);
        assert_eq!(p.packages.len(), 1);
        assert_eq!(p.packages[0].package, "my_pkg");
        assert_eq!(p.packages[0].count, 2);
    }

    #[test]
    fn an_indented_vars_key_is_not_the_project_block() {
        let p = scan("models:\n  my_project:\n    vars:\n      alpha: 1\n");
        assert!(!p.found);
        assert!(p.vars.is_empty());
    }

    #[test]
    fn no_vars_block_at_all() {
        let p = scan("name: demo\nversion: '1.0'\n");
        assert!(!p.found);
    }

    #[test]
    fn an_empty_block_is_found_but_has_nothing() {
        let p = scan("vars:\nquoting:\n  database: false\n");
        assert!(p.found);
        assert!(p.vars.is_empty());
    }

    #[test]
    fn a_tab_indent_is_unparsed() {
        let p = scan("vars:\n  alpha: 1\n\tbeta: 2\n");
        assert_eq!(names(&p), ["alpha"]);
        assert_eq!(p.unparsed[0].message, "tabs are not valid YAML indentation");
    }

    #[test]
    fn a_merge_key_is_unparsed() {
        let p = scan("vars:\n  <<: *defaults\n  alpha: 1\n");
        assert_eq!(names(&p), ["alpha"]);
        assert_eq!(p.unparsed[0].message, "a merge key is not read");
    }

    #[test]
    fn a_block_scalar_and_a_flow_mapping_are_unparsed() {
        let p = scan("vars:\n  text: |\n    a line\n  map: {a: 1}\n");
        assert!(p.vars.is_empty());
        assert_eq!(p.unparsed.len(), 3, "block scalar, its indented body, then the flow mapping");
    }

    #[test]
    fn a_duplicate_key_keeps_the_last_and_warns() {
        let p = scan("vars:\n  alpha: 1\n  alpha: 2\n");
        assert_eq!(names(&p), ["alpha"]);
        assert_eq!(raw(&p, "alpha"), "2");
        assert_eq!(p.unparsed[0].message, "a duplicate key, the last one wins");
    }

    #[test]
    fn crlf_line_endings_read_the_same() {
        let unix = scan("vars:\n  alpha: 1\n  beta: two\n");
        let dos = scan("vars:\r\n  alpha: 1\r\n  beta: two\r\n");
        assert_eq!(unix, dos);
    }

    #[test]
    fn a_utf8_bom_does_not_rename_the_first_key() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"vars:\n  alpha: 1\n");
        let p = scan(&crate::envs::decode(&bytes));
        assert_eq!(names(&p), ["alpha"]);
    }

    #[test]
    fn line_numbers_are_one_based() {
        let p = scan("name: demo\n\nvars:\n  alpha: 1\n");
        assert_eq!(p.vars[0].line, 4);
    }
}
