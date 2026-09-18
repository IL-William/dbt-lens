//! Column lineage: the cache file, and naming warehouse objects as dbt nodes.
//!
//! The cache is deliberately source agnostic: it names nodes and columns, never
//! warehouse objects, so the same file shape can later be filled from dbt
//! Fusion's parquet index instead of Snowflake without touching the graph.
//! Objects become nodes before anything is written, in `edges_for`.

use crate::envs::{self, Status, Vars};
use crate::graph::{Graph, Kind};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;

#[derive(serde::Serialize, serde::Deserialize, Default, Clone, Debug)]
pub struct RawColLineage {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub generated_at: String,
    /// What a `dump` could not read, kept so merging into its file loses nothing.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
    #[serde(default)]
    pub edges: Vec<RawColEdge>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct RawColEdge {
    /// dbt unique_id, or `rel:<db.schema.object>` for something dbt does not own.
    pub from: String,
    pub from_col: String,
    pub to: String,
    pub to_col: String,
    #[serde(default)]
    pub kind: String,
}

/// A column pair between two warehouse objects, named the way the warehouse
/// names them: what the Snowflake script answers with.
#[derive(serde::Deserialize, Clone, Debug, PartialEq)]
pub struct RelEdge {
    pub from_rel: String,
    pub from_col: String,
    pub to_rel: String,
    pub to_col: String,
    #[serde(default)]
    pub kind: String,
}

impl RawColLineage {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let bytes = std::fs::read(path)?;
        let parsed: RawColLineage = serde_json::from_slice(&bytes)?;
        if parsed.version > 1 {
            anyhow::bail!("cache version {} is newer than this build understands", parsed.version);
        }
        Ok(parsed)
    }

    /// Adds the edges not already present, compared by node and column name.
    /// Returns how many were new.
    pub fn add(&mut self, edges: Vec<RawColEdge>) -> usize {
        let key = |e: &RawColEdge| (e.from.clone(), e.from_col.to_lowercase(), e.to.clone(), e.to_col.to_lowercase());
        let mut seen: HashSet<_> = self.edges.iter().map(key).collect();
        let before = self.edges.len();
        for edge in edges {
            if seen.insert(key(&edge)) {
                self.edges.push(edge);
            }
        }
        self.edges.len() - before
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let bytes = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        crate::settings::write_atomic(path, &bytes)
    }
}

/// Why a cache from another source is left alone: a synthetic cache looks
/// exactly like a real one, and completing it would make every edge suspect.
pub fn other_source(path: &Path, source: &str) -> String {
    let source = if source.is_empty() { "an unknown source" } else { source };
    format!("{} holds column lineage from {source}, not Snowflake. Move it away to fetch lineage from Snowflake.", path.display())
}

/// Adds edges to the cache file at `path`, creating it if needed. Returns the
/// whole cache and how many edges were new, or None when all were already
/// there, in which case nothing is written.
pub fn add_to_file(path: &Path, edges: Vec<RawColEdge>, target: &str, now: u64) -> Result<Option<(RawColLineage, usize)>, String> {
    let mut cache = if path.exists() {
        RawColLineage::load(path).map_err(|e| format!("cannot read {}: {e}. Move it away to fetch lineage from Snowflake.", path.display()))?
    } else {
        RawColLineage::default()
    };
    if !cache.edges.is_empty() && cache.source != "snowflake" {
        return Err(other_source(path, &cache.source));
    }
    let added = cache.add(edges);
    if added == 0 {
        return Ok(None);
    }
    cache.version = 1;
    cache.source = "snowflake".into();
    cache.target = target.to_string();
    cache.generated_at = iso_utc(now);
    cache.save(path).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(Some((cache, added)))
}

/// The parts of a relation name, split on the dots outside double quotes.
fn relation_parts(relation: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let (mut start, mut quoted) = (0, false);
    for (i, c) in relation.char_indices() {
        match c {
            '"' => quoted = !quoted,
            '.' if !quoted => {
                parts.push(&relation[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&relation[start..]);
    parts
}

/// `database.schema.object`, each part optionally quoted, the way the browser
/// shows a relation. It only ever reaches Snowflake as a bound parameter, so
/// this keeps out nonsense rather than injection.
pub fn valid_relation(relation: &str) -> bool {
    let parts = relation_parts(relation);
    relation.len() <= 512
        && !relation.chars().any(char::is_control)
        && parts.len() == 3
        && parts.iter().all(|p| !p.trim().is_empty())
}

fn same_relation(a: &str, b: &str) -> bool {
    let (a, b) = (relation_parts(a), relation_parts(b));
    a.len() == b.len() && a.iter().zip(&b).all(|(x, y)| envs::same_ident(x, y))
}

/// The node a warehouse object stands for, or None.
///
/// Candidates share the object's name. Database and schema then decide:
/// compared with where dbt built the node, or, given an environment file's
/// variables, with where that environment puts it, by the rules the Catalog's
/// resolved relation follows. An enabled node wins over a disabled one, and two
/// that still both fit give None: a guessed edge is worse than a missing one.
pub fn node_for(graph: &Graph, object: &str, vars: Option<&Vars>) -> Option<u32> {
    let parts = relation_parts(object);
    let [db, schema, name] = parts.as_slice() else { return None };
    let (mut enabled, mut disabled) = (Vec::new(), Vec::new());
    for (i, n) in graph.nodes.iter().enumerate() {
        if !matches!(n.kind, Kind::Model | Kind::Source | Kind::Seed | Kind::Snapshot) {
            continue;
        }
        let fits = match vars {
            None => envs::same_ident(&n.alias, name) && envs::same_ident(&n.database, db) && envs::same_ident(&n.schema, schema),
            Some(vars) => {
                // Resolving every node would be wasted: only a templated alias
                // can move a node to another name.
                let templated = n.written.alias.contains("{{") || n.written.alias.contains("{%");
                if !templated && !envs::same_ident(&n.alias, name) {
                    continue;
                }
                let r = envs::resolve_place(&n.written, &n.parsed, vars);
                let usable = |kind: Status| !matches!(kind, Status::Missing | Status::Placeholder | Status::Unevaluated);
                // An unset alias is the one dbt built: dbt derives it from the node.
                let alias = if usable(r.status.alias.kind) && !r.place.alias.is_empty() { &r.place.alias } else { &n.alias };
                usable(r.status.database.kind)
                    && usable(r.status.schema.kind)
                    && envs::same_ident(&r.place.database, db)
                    && envs::same_ident(&r.place.schema, schema)
                    && envs::same_ident(alias, name)
            }
        };
        if fits {
            if n.disabled { &mut disabled } else { &mut enabled }.push(i as u32);
        }
    }
    match (enabled.as_slice(), disabled.as_slice()) {
        ([one], _) | ([], [one]) => Some(*one),
        _ => None,
    }
}

/// Warehouse pairs as cache edges. `focus` is the node the user clicked and
/// `relation` its name as the browser showed it, so that end needs no matching.
/// A pair with an end that is no node of this project is left out, and its
/// objects are returned, sorted, so the UI can say what was skipped.
pub fn edges_for(
    graph: &Graph,
    rows: &[RelEdge],
    focus: u32,
    relation: &str,
    vars: Option<&Vars>,
) -> (Vec<RawColEdge>, Vec<String>) {
    let mut known: HashMap<String, Option<u32>> = HashMap::new();
    let mut lookup = |object: &str| {
        if same_relation(object, relation) {
            return Some(focus);
        }
        *known.entry(object.to_uppercase()).or_insert_with(|| node_for(graph, object, vars))
    };
    let mut edges = Vec::new();
    let mut unmatched = BTreeSet::new();
    for row in rows {
        let (from, to) = (lookup(&row.from_rel), lookup(&row.to_rel));
        let (Some(from), Some(to)) = (from, to) else {
            if from.is_none() {
                unmatched.insert(row.from_rel.clone());
            }
            if to.is_none() {
                unmatched.insert(row.to_rel.clone());
            }
            continue;
        };
        let (from_col, to_col) = (row.from_col.to_lowercase(), row.to_col.to_lowercase());
        if from == to && from_col == to_col {
            continue;
        }
        edges.push(RawColEdge {
            from: graph.nodes[from as usize].id.clone(),
            from_col,
            to: graph.nodes[to as usize].id.clone(),
            to_col,
            kind: row.kind.clone(),
        });
    }
    (edges, unmatched.into_iter().collect())
}

/// `2026-09-17T20:04:05Z` for a Unix time: the format the script writes.
pub fn iso_utc(secs: u64) -> String {
    // Days to a civil date, after Howard Hinnant's `civil_from_days`.
    let z = (secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let rem = secs % 86_400;
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem / 60 % 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::RawManifest;

    fn model(name: &str, package: &str, schema: &str) -> serde_json::Value {
        serde_json::json!({
            "name": name,
            "resource_type": "model",
            "package_name": package,
            "original_file_path": format!("models/{name}.sql"),
            // Built by a developer target, away from the configured schema.
            "database": "analytics",
            "schema": "dbt_someone",
            "alias": name.trim_end_matches("_v1"),
            "relation_name": format!("analytics.dbt_someone.{name}"),
            "unrendered_config": { "database": "{{ env_var('SHOP_DB_ANALYTICS') }}", "schema": schema },
            "config": { "materialized": "view", "database": "analytics_ci", "schema": schema },
            "columns": { "customer_id": { "name": "customer_id" } },
        })
    }

    /// Invented names: a staging model, a mart, a source, two models sharing an
    /// alias, and a disabled copy of the mart.
    fn fixture() -> Graph {
        let raw: RawManifest = serde_json::from_value(serde_json::json!({
            "nodes": {
                "model.shop.stg_customers": model("stg_customers", "shop", "staging"),
                "model.shop.dim_customers": model("dim_customers", "shop", "marts"),
                "model.shop.orders": model("orders", "shop", "marts"),
                "model.finance.orders": model("orders", "finance", "finance"),
            },
            "sources": {
                "source.shop.crm.customers": {
                    "name": "customers",
                    "resource_type": "source",
                    "source_name": "crm",
                    "package_name": "shop",
                    "database": "raw_ci",
                    "schema": "crm",
                    "identifier": "CUSTOMERS",
                    "unrendered_database": "{{ env_var('SHOP_DB_RAW') }}",
                    "unrendered_schema": "crm",
                    "relation_name": "raw_ci.crm.CUSTOMERS",
                },
            },
            "disabled": {
                "model.shop.dim_customers_v1": [model("dim_customers_v1", "shop", "marts")],
            },
        }))
        .unwrap();
        Graph::build(raw, Path::new("manifest.json"), 0, 0)
    }

    fn vars(pairs: &[(&str, &str)]) -> Vars {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn id(graph: &Graph, object: &str, vars: Option<&Vars>) -> Option<String> {
        node_for(graph, object, vars).map(|i| graph.nodes[i as usize].id.clone())
    }

    #[test]
    fn without_an_environment_objects_match_where_dbt_built_them() {
        let g = fixture();
        assert_eq!(id(&g, "ANALYTICS.DBT_SOMEONE.STG_CUSTOMERS", None).as_deref(), Some("model.shop.stg_customers"));
        assert_eq!(id(&g, "RAW_CI.CRM.CUSTOMERS", None).as_deref(), Some("source.shop.crm.customers"));
        // The configured location is not where this manifest built it.
        assert_eq!(id(&g, "ANALYTICS_CI.STAGING.STG_CUSTOMERS", None), None);
        assert_eq!(id(&g, "ANALYTICS.DBT_SOMEONE", None), None);
    }

    #[test]
    fn with_an_environment_objects_match_where_it_puts_them() {
        let g = fixture();
        let uat = vars(&[("SHOP_DB_ANALYTICS", "analytics_uat"), ("SHOP_DB_RAW", "raw_uat")]);
        assert_eq!(id(&g, "ANALYTICS_UAT.STAGING.STG_CUSTOMERS", Some(&uat)).as_deref(), Some("model.shop.stg_customers"));
        assert_eq!(id(&g, "RAW_UAT.CRM.CUSTOMERS", Some(&uat)).as_deref(), Some("source.shop.crm.customers"));
        assert_eq!(id(&g, r#""RAW_UAT"."crm"."CUSTOMERS""#, Some(&uat)).as_deref(), Some("source.shop.crm.customers"));
        // The sandbox is not where UAT builds anything.
        assert_eq!(id(&g, "ANALYTICS.DBT_SOMEONE.STG_CUSTOMERS", Some(&uat)), None);

        // A variable the file does not define leaves the node unplaceable.
        let partial = vars(&[("SHOP_DB_ANALYTICS", "analytics_uat")]);
        assert_eq!(id(&g, "RAW_UAT.CRM.CUSTOMERS", Some(&partial)), None);
        let placeholder = vars(&[("SHOP_DB_ANALYTICS", "analytics_uat"), ("SHOP_DB_RAW", "<raw database>")]);
        assert_eq!(id(&g, "<RAW DATABASE>.CRM.CUSTOMERS", Some(&placeholder)), None);
    }

    #[test]
    fn two_nodes_that_both_fit_match_neither_and_enabled_beats_disabled() {
        let g = fixture();
        // Both `orders` models were built into the same sandbox schema.
        assert_eq!(id(&g, "ANALYTICS.DBT_SOMEONE.ORDERS", None), None);
        // An environment tells them apart again.
        let uat = vars(&[("SHOP_DB_ANALYTICS", "analytics_uat")]);
        assert_eq!(id(&g, "ANALYTICS_UAT.FINANCE.ORDERS", Some(&uat)).as_deref(), Some("model.finance.orders"));
        // The disabled copy shares the mart's name and place.
        assert!(g.nodes[g.index["model.shop.dim_customers_v1"] as usize].disabled);
        assert_eq!(id(&g, "ANALYTICS.DBT_SOMEONE.DIM_CUSTOMERS", None).as_deref(), Some("model.shop.dim_customers"));
    }

    #[test]
    fn edges_name_nodes_and_list_what_is_not_in_the_project() {
        let g = fixture();
        let focus = g.index["model.shop.dim_customers"];
        let pair = |from: &str, from_col: &str, to: &str, to_col: &str| RelEdge {
            from_rel: from.into(),
            from_col: from_col.into(),
            to_rel: to.into(),
            to_col: to_col.into(),
            kind: "view".into(),
        };
        let rows = [
            pair("ANALYTICS.DBT_SOMEONE.STG_CUSTOMERS", "CUSTOMER_ID", "ANALYTICS.DBT_SOMEONE.DIM_CUSTOMERS", "CUSTOMER_ID"),
            pair("RAW_CI.CRM.CUSTOMERS", "ID", "ANALYTICS.DBT_SOMEONE.STG_CUSTOMERS", "CUSTOMER_ID"),
            pair("LANDING.FTP.CUSTOMERS_FILE", "ID", "RAW_CI.CRM.CUSTOMERS", "ID"),
        ];
        // The clicked node is named as the browser quoted it, and still found.
        let (edges, unmatched) = edges_for(&g, &rows, focus, r#""analytics"."dbt_someone"."dim_customers""#, None);
        assert_eq!(
            edges.iter().map(|e| (e.from.as_str(), e.from_col.as_str(), e.to.as_str(), e.to_col.as_str())).collect::<Vec<_>>(),
            [
                ("model.shop.stg_customers", "customer_id", "model.shop.dim_customers", "customer_id"),
                ("source.shop.crm.customers", "id", "model.shop.stg_customers", "customer_id"),
            ]
        );
        assert_eq!(unmatched, ["LANDING.FTP.CUSTOMERS_FILE"]);
    }

    #[test]
    fn adding_skips_edges_already_there_and_the_file_round_trips() {
        let edge = |to_col: &str| RawColEdge {
            from: "model.shop.stg_customers".into(),
            from_col: "customer_id".into(),
            to: "model.shop.dim_customers".into(),
            to_col: to_col.into(),
            kind: "view".into(),
        };
        let mut cache = RawColLineage { version: 1, source: "snowflake".into(), ..Default::default() };
        assert_eq!(cache.add(vec![edge("customer_id"), edge("customer_id")]), 1);
        assert_eq!(cache.add(vec![edge("CUSTOMER_ID"), edge("customer_key")]), 1);
        assert_eq!(cache.edges.len(), 2);

        let dir = std::env::temp_dir().join(format!("dbt-lens-collin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("target").join("column_lineage.json");
        cache.errors.push("model.shop.x.y: denied".into());
        cache.save(&path).unwrap();
        let loaded = RawColLineage::load(&path).unwrap();
        assert_eq!((loaded.source.as_str(), loaded.edges.len()), ("snowflake", 2));
        assert_eq!(loaded.edges[1], edge("customer_key"));
        assert_eq!(loaded.errors, ["model.shop.x.y: denied"], "a dump's errors survive a merge");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_file_grows_only_with_new_snowflake_edges() {
        let dir = std::env::temp_dir().join(format!("dbt-lens-collin-file-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("target").join("column_lineage.json");
        let edge = RawColEdge {
            from: "model.shop.stg_customers".into(),
            from_col: "customer_id".into(),
            to: "model.shop.dim_customers".into(),
            to_col: "customer_id".into(),
            kind: "view".into(),
        };

        let (cache, added) = add_to_file(&path, vec![edge.clone()], "dev", 1_789_675_445).unwrap().unwrap();
        assert_eq!((added, cache.source.as_str(), cache.target.as_str()), (1, "snowflake", "dev"));
        assert_eq!(RawColLineage::load(&path).unwrap().generated_at, "2026-09-17T20:04:05Z");

        let written = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert!(add_to_file(&path, vec![edge.clone()], "dev", 1_789_675_999).unwrap().is_none());
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), written, "nothing new, nothing written");

        let synthetic = RawColLineage { version: 1, source: "synthetic".into(), edges: vec![edge.clone()], ..Default::default() };
        synthetic.save(&path).unwrap();
        let refused = add_to_file(&path, vec![edge], "dev", 0).unwrap_err();
        assert!(refused.contains("from synthetic, not Snowflake"), "{refused}");
        assert_eq!(RawColLineage::load(&path).unwrap().source, "synthetic", "the other source's file is left as it was");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_relation_is_three_named_parts() {
        assert!(valid_relation("analytics.marts.dim_customers"));
        assert!(valid_relation(r#""RAW"."crm.eu"."Customers""#), "a dot inside quotes is part of the name");
        assert!(!valid_relation("analytics.dim_customers"));
        assert!(!valid_relation("analytics..dim_customers"));
        assert!(!valid_relation("a.b.c.d"));
        assert!(!valid_relation("a.b.c\nselect 1"));
        assert!(!valid_relation(&format!("a.b.{}", "c".repeat(600))));
    }

    #[test]
    fn times_are_written_like_the_script_writes_them() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(iso_utc(1_789_675_445), "2026-09-17T20:04:05Z");
        assert_eq!(iso_utc(4_102_444_799), "2099-12-31T23:59:59Z");
    }
}
