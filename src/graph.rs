//! Compact in-memory lineage graph built from a dbt manifest.
//!
//! Nodes are stored in a flat `Vec` and referenced by `u32` index, so adjacency
//! lists stay small even on projects with tens of thousands of nodes.

use crate::collin::RawColLineage;
use crate::manifest::{RawCatalog, RawManifest, RawNode};
use std::collections::HashMap;

#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Model,
    Source,
    Seed,
    Snapshot,
    Test,
    Exposure,
    Analysis,
    Operation,
    Other,
}

impl Kind {
    fn parse(s: &str) -> Kind {
        match s {
            "model" => Kind::Model,
            "source" => Kind::Source,
            "seed" => Kind::Seed,
            "snapshot" => Kind::Snapshot,
            "test" | "unit_test" => Kind::Test,
            "exposure" => Kind::Exposure,
            "analysis" => Kind::Analysis,
            "operation" => Kind::Operation,
            _ => Kind::Other,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Model => "model",
            Kind::Source => "source",
            Kind::Seed => "seed",
            Kind::Snapshot => "snapshot",
            Kind::Test => "test",
            Kind::Exposure => "exposure",
            Kind::Analysis => "analysis",
            Kind::Operation => "operation",
            Kind::Other => "other",
        }
    }
    /// Tests and operations are hidden from the lineage canvas by default: they
    /// are attached to their parent instead of drawn as graph nodes.
    fn is_graph_node(self) -> bool {
        !matches!(self, Kind::Test | Kind::Operation)
    }
}

/// Where a node lives, at one stage of dbt's resolution.
#[derive(Default, Clone, Debug, PartialEq, serde::Serialize)]
pub struct Place {
    pub database: String,
    pub schema: String,
    pub alias: String,
}

/// A config value as text: a JSON string as-is, null as empty, anything else
/// in its JSON form so an unexpected shape is visible rather than dropped.
fn text(v: &Option<serde_json::Value>) -> String {
    match v {
        None | Some(serde_json::Value::Null) => String::new(),
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

pub struct Column {
    pub name: String,
    pub data_type: String,
    pub description: String,
    /// Names of the data tests guarding this column (not_null, unique, ...).
    pub tests: Vec<String>,
    /// True when the column only exists in catalog.json, i.e. it is in the
    /// warehouse but not declared in YAML.
    pub undeclared: bool,
}

pub struct Node {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    pub file: String,
    pub yml: String,
    pub schema: String,
    pub database: String,
    pub relation: String,
    /// Final name in the warehouse: the model alias, or a source identifier.
    pub alias: String,
    /// Location as written in config, Jinja and all.
    pub written: Place,
    /// Location as dbt parsed it: config with whatever env vars were loaded at
    /// parse time, before the generate_*_name macros. Not "the" environment.
    pub parsed: Place,
    pub materialized: String,
    pub strategy: String,
    pub unique_key: String,
    pub package: String,
    pub description: String,
    pub tags: Vec<String>,
    pub disabled: bool,
    pub columns: Vec<Column>,
    /// Test nodes only: the short test name and the column it is attached to.
    pub test_name: String,
    pub column: String,
    attached: String,
    pub parents: Vec<u32>,
    pub children: Vec<u32>,
    pub tests: Vec<u32>,
    search_key: String,
}

#[derive(serde::Serialize, Clone, Default)]
pub struct KindCount {
    pub kind: String,
    pub edges: usize,
}

#[derive(serde::Serialize, Clone, Default)]
pub struct Meta {
    pub project: String,
    pub dbt_version: String,
    pub adapter: String,
    pub generated_at: String,
    pub manifest_path: String,
    pub manifest_mtime: u64,
    pub catalog_mtime: u64,
    pub catalog_columns: usize,
    pub cll_edges: usize,
    pub cll_dropped: usize,
    pub cll_mtime: u64,
    /// Where the cache says it came from: "snowflake", "fusion", ...
    pub cll_source: String,
    /// Which file it was read from.
    pub cll_file: String,
    pub cll_target: String,
    pub cll_generated_at: String,
    pub cll_kinds: Vec<KindCount>,
    /// Set when nearly every model was built into one database.schema: the
    /// manifest comes from a developer sandbox target, so a model built away
    /// from its configured location is the norm rather than a finding.
    pub sandbox: String,
    pub sandbox_models: usize,
    pub load_ms: u128,
    pub counts: HashMap<String, usize>,
}

/// One column of one node. Valid only for the lifetime of a single `Arc<Graph>`,
/// because `col` is a position in `Node.columns`.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct ColRef {
    pub node: u32,
    pub col: u32,
}

#[derive(Clone, Copy)]
pub struct ColEdge {
    pub from: ColRef,
    pub to: ColRef,
    pub kind: u8,
}

/// Column-level edges, held flat rather than as per-column vectors: this
/// large project has hundreds of thousands of columns, and two `Vec`s each would dwarf the edges.
#[derive(Default)]
pub struct ColLineage {
    edges: Vec<ColEdge>,
    /// Indices into `edges`, ordered by target, so incoming lookups binary search too.
    by_to: Vec<u32>,
    /// Interned edge kinds; `ColEdge.kind` indexes this.
    pub kinds: Vec<String>,
}

impl ColLineage {
    pub fn outgoing(&self, r: ColRef) -> &[ColEdge] {
        let lo = self.edges.partition_point(|e| e.from < r);
        let hi = self.edges.partition_point(|e| e.from <= r);
        &self.edges[lo..hi]
    }

    pub fn incoming(&self, r: ColRef) -> impl Iterator<Item = &ColEdge> {
        let lo = self.by_to.partition_point(|&i| self.edges[i as usize].to < r);
        let hi = self.by_to.partition_point(|&i| self.edges[i as usize].to <= r);
        self.by_to[lo..hi].iter().map(move |&i| &self.edges[i as usize])
    }

    /// (upstream, downstream) edge counts, for the Columns table.
    pub fn degree(&self, r: ColRef) -> (usize, usize) {
        (self.incoming(r).count(), self.outgoing(r).len())
    }
}

pub struct Graph {
    pub nodes: Vec<Node>,
    pub index: HashMap<String, u32>,
    pub by_file: HashMap<String, Vec<u32>>,
    /// Node name -> index, for resolving ref() and source() from the editor.
    pub by_name: HashMap<String, u32>,
    pub catalog_mtime: u64,
    pub cll: Option<ColLineage>,
    pub meta: Meta,
}

impl Graph {
    pub fn build(raw: RawManifest, manifest_path: &std::path::Path, mtime: u64, load_ms: u128) -> Graph {
        let mut nodes: Vec<Node> = Vec::with_capacity(raw.nodes.len() + raw.sources.len());
        let mut index: HashMap<String, u32> = HashMap::with_capacity(nodes.capacity());

        let push = |id: String,
                    raw_node: RawNode,
                    from_disabled: bool,
                    nodes: &mut Vec<Node>,
                    index: &mut HashMap<String, u32>| {
            let off = raw_node.config.enabled == Some(false);
            // Disabled tests are dead weight; disabled models are still worth
            // resolving, because ref() calls point at them.
            if off && !from_disabled {
                return;
            }
            if index.contains_key(&id) {
                return;
            }
            let kind = Kind::parse(&raw_node.resource_type);
            let name = match (&kind, &raw_node.source_name) {
                (Kind::Source, Some(src)) => format!("{}.{}", src, raw_node.name),
                _ => raw_node.name.clone(),
            };
            // Tests exist in their thousands; keep them skeletal.
            let heavy = kind != Kind::Test;
            let mut columns: Vec<Column> = if heavy {
                raw_node
                    .columns
                    .into_iter()
                    .map(|(_, c)| Column {
                        name: c.name,
                        data_type: c.data_type.unwrap_or_default(),
                        description: c.description,
                        tests: Vec::new(),
                        undeclared: false,
                    })
                    .collect()
            } else {
                Vec::new()
            };
            columns.sort_by(|a, b| a.name.cmp(&b.name));

            let file = raw_node.original_file_path;
            let search_key = format!("{}\u{0}{}", name.to_lowercase(), file.to_lowercase());
            index.insert(id.clone(), nodes.len() as u32);
            nodes.push(Node {
                id,
                name,
                kind,
                yml: raw_node
                    .patch_path
                    .unwrap_or_default()
                    .split_once("://")
                    .map(|(_, p)| p.to_string())
                    .unwrap_or_default(),
                file,
                schema: raw_node.schema.clone().unwrap_or_default(),
                database: raw_node.database.clone().unwrap_or_default(),
                relation: raw_node.relation_name.unwrap_or_default(),
                alias: raw_node.identifier.clone().or(raw_node.alias.clone()).unwrap_or_default(),
                // Sources carry their raw location at top level; models carry it
                // in unrendered_config. Tests stay skeletal.
                written: match (heavy, kind) {
                    (false, _) => Place::default(),
                    (true, Kind::Source) => Place {
                        database: raw_node.unrendered_database.clone().unwrap_or_default(),
                        schema: raw_node.unrendered_schema.clone().unwrap_or_default(),
                        alias: String::new(),
                    },
                    (true, _) => Place {
                        database: text(&raw_node.unrendered_config.database),
                        schema: text(&raw_node.unrendered_config.schema),
                        alias: text(&raw_node.unrendered_config.alias),
                    },
                },
                parsed: match (heavy, kind) {
                    (false, _) => Place::default(),
                    (true, Kind::Source) => Place {
                        database: raw_node.database.clone().unwrap_or_default(),
                        schema: raw_node.schema.clone().unwrap_or_default(),
                        alias: raw_node.identifier.clone().unwrap_or_default(),
                    },
                    (true, _) => Place {
                        database: text(&raw_node.config.database),
                        schema: text(&raw_node.config.schema),
                        alias: text(&raw_node.config.alias),
                    },
                },
                materialized: match kind {
                    Kind::Source => "source".into(),
                    _ => raw_node.config.materialized.unwrap_or_default(),
                },
                strategy: raw_node.config.incremental_strategy.unwrap_or_default(),
                unique_key: match raw_node.config.unique_key {
                    Some(serde_json::Value::String(s)) => s,
                    Some(serde_json::Value::Array(a)) => a
                        .iter()
                        .filter_map(|v| v.as_str())
                        .collect::<Vec<_>>()
                        .join(", "),
                    _ => String::new(),
                },
                package: raw_node.package_name,
                description: if heavy { raw_node.description } else { String::new() },
                // Tests keep their tags even though the rest of them stays skeletal:
                // selections such as `--exclude tag:test-reconciliation` match
                // tests and nothing else, so dropping these makes any selector
                // answer quietly wrong. 2832 tagged tests here, 23 distinct tags.
                tags: raw_node.tags,
                disabled: off || from_disabled,
                columns,
                test_name: raw_node.test_metadata.map(|m| m.name).unwrap_or_default(),
                column: raw_node.column_name.unwrap_or_default(),
                attached: raw_node.attached_node.unwrap_or_default(),
                parents: Vec::new(),
                children: Vec::new(),
                tests: Vec::new(),
                search_key,
            });
        };

        // `depends_on` is captured before the raw nodes are consumed.
        let mut deps: Vec<(String, Vec<String>)> = Vec::new();
        for (id, node) in raw.nodes {
            deps.push((id.clone(), node.depends_on.nodes.clone()));
            push(id, node, false, &mut nodes, &mut index);
        }
        for (id, node) in raw.sources {
            push(id, node, false, &mut nodes, &mut index);
        }
        for (id, node) in raw.exposures {
            deps.push((id.clone(), node.depends_on.nodes.clone()));
            push(id, node, false, &mut nodes, &mut index);
        }
        for (id, mut variants) in raw.disabled {
            if variants.is_empty() {
                continue;
            }
            let node = variants.swap_remove(0);
            if node.resource_type == "test" {
                continue;
            }
            push(id, node, true, &mut nodes, &mut index);
        }

        // `parent_map` is authoritative when present; `depends_on` is the fallback.
        let edges: Vec<(String, Vec<String>)> = if raw.parent_map.is_empty() {
            deps
        } else {
            raw.parent_map.into_iter().collect()
        };

        for (child_id, parent_ids) in edges {
            let Some(&ci) = index.get(&child_id) else { continue };
            for parent_id in parent_ids {
                let Some(&pi) = index.get(&parent_id) else { continue };
                if pi == ci {
                    continue;
                }
                if nodes[ci as usize].kind == Kind::Test {
                    nodes[pi as usize].tests.push(ci);
                    nodes[ci as usize].parents.push(pi);
                } else if nodes[pi as usize].kind.is_graph_node() {
                    nodes[ci as usize].parents.push(pi);
                    nodes[pi as usize].children.push(ci);
                }
            }
        }
        for n in nodes.iter_mut() {
            n.parents.sort_unstable();
            n.parents.dedup();
            n.children.sort_unstable();
            n.children.dedup();
            n.tests.sort_unstable();
            n.tests.dedup();
        }

        // Hang every column-level test off the column it guards.
        for i in 0..nodes.len() {
            if nodes[i].kind != Kind::Test || nodes[i].column.is_empty() {
                continue;
            }
            let owner = if nodes[i].attached.is_empty() {
                nodes[i].parents.first().copied()
            } else {
                index.get(&nodes[i].attached).copied()
            };
            let Some(owner) = owner else { continue };
            let wanted = nodes[i].column.to_lowercase();
            let label = if nodes[i].test_name.is_empty() {
                nodes[i].name.clone()
            } else {
                nodes[i].test_name.clone()
            };
            if let Some(col) = nodes[owner as usize]
                .columns
                .iter_mut()
                .find(|c| c.name.to_lowercase() == wanted)
            {
                col.tests.push(label);
            }
        }
        for n in nodes.iter_mut() {
            for c in n.columns.iter_mut() {
                c.tests.sort();
                c.tests.dedup();
            }
        }

        let mut by_name: HashMap<String, u32> = HashMap::new();
        for (i, n) in nodes.iter().enumerate() {
            if n.kind == Kind::Test || n.kind == Kind::Operation {
                continue;
            }
            // Enabled beats disabled, and a model beats anything else.
            let rank = |n: &Node| (!n.disabled as u8) * 2 + (n.kind == Kind::Model) as u8;
            match by_name.get(&n.name) {
                Some(&prev) if rank(&nodes[prev as usize]) >= rank(n) => {}
                _ => {
                    by_name.insert(n.name.clone(), i as u32);
                }
            }
        }

        // Sandbox detection: one built location holding at least 95% of models.
        let mut built: HashMap<(String, String), usize> = HashMap::new();
        let mut enabled_models = 0usize;
        for n in nodes.iter().filter(|n| n.kind == Kind::Model && !n.disabled) {
            enabled_models += 1;
            *built.entry((n.database.to_lowercase(), n.schema.to_lowercase())).or_insert(0) += 1;
        }
        let sandbox = built
            .into_iter()
            .max_by_key(|(_, count)| *count)
            .filter(|(_, count)| enabled_models >= 20 && *count * 100 >= enabled_models * 95);

        let mut by_file: HashMap<String, Vec<u32>> = HashMap::new();
        let mut counts: HashMap<String, usize> = HashMap::new();
        for (i, n) in nodes.iter().enumerate() {
            if n.disabled {
                *counts.entry("disabled".to_string()).or_insert(0) += 1;
            } else {
                *counts.entry(n.kind.as_str().to_string()).or_insert(0) += 1;
            }
            if !n.file.is_empty() {
                by_file.entry(n.file.clone()).or_default().push(i as u32);
            }
            if !n.yml.is_empty() {
                by_file.entry(n.yml.clone()).or_default().push(i as u32);
            }
        }

        Graph {
            meta: Meta {
                project: raw.metadata.project_name,
                dbt_version: raw.metadata.dbt_version,
                adapter: raw.metadata.adapter_type,
                generated_at: raw.metadata.generated_at,
                manifest_path: manifest_path.display().to_string(),
                manifest_mtime: mtime,
                sandbox: sandbox.as_ref().map(|((d, s), _)| format!("{d}.{s}")).unwrap_or_default(),
                sandbox_models: sandbox.as_ref().map(|(_, c)| *c).unwrap_or(0),
                catalog_mtime: 0,
                catalog_columns: 0,
                cll_edges: 0,
                cll_dropped: 0,
                cll_mtime: 0,
                cll_source: String::new(),
                cll_file: String::new(),
                cll_target: String::new(),
                cll_generated_at: String::new(),
                cll_kinds: Vec::new(),
                load_ms,
                counts,
            },
            nodes,
            index,
            by_file,
            by_name,
            catalog_mtime: 0,
            cll: None,
        }
    }

    /// Position of a column within a node, matched case-insensitively.
    pub fn col_slot(&self, node: u32, name: &str) -> Option<u32> {
        let wanted = name.to_lowercase();
        self.nodes[node as usize]
            .columns
            .iter()
            .position(|c| c.name.to_lowercase() == wanted)
            .map(|i| i as u32)
    }

    /// Folds a column-lineage cache into the graph.
    ///
    /// MUST run after `merge_catalog`. Both functions re-sort `Node.columns`,
    /// and the `ColRef` slots built here are positions in that final order, so
    /// running this first would silently attach edges to the wrong columns.
    pub fn merge_col_lineage(&mut self, raw: RawColLineage, mtime: u64) -> usize {
        const MAX_EDGES: usize = 5_000_000;
        let mut dropped = 0usize;

        // 1. Materialise columns the lineage knows about but the YAML does not.
        let mut touched: Vec<u32> = Vec::new();
        let mut want: Vec<(u32, String)> = Vec::new();
        for e in &raw.edges {
            for (id, col) in [(&e.from, &e.from_col), (&e.to, &e.to_col)] {
                match self.index.get(id.as_str()) {
                    Some(&n) => want.push((n, col.to_lowercase())),
                    None => dropped += 1,
                }
            }
        }
        want.sort();
        want.dedup();
        for (n, col) in &want {
            let node = &mut self.nodes[*n as usize];
            if !node.columns.iter().any(|c| c.name.to_lowercase() == *col) {
                node.columns.push(Column {
                    name: col.clone(),
                    data_type: String::new(),
                    description: String::new(),
                    tests: Vec::new(),
                    undeclared: true,
                });
                touched.push(*n);
            }
        }
        touched.sort_unstable();
        touched.dedup();
        for n in &touched {
            self.nodes[*n as usize].columns.sort_by(|a, b| a.name.cmp(&b.name));
        }

        // 2. Name -> slot, built here and thrown away, so nothing can go stale.
        let mut slot: HashMap<(u32, String), u32> = HashMap::new();
        let mut indexed: std::collections::HashSet<u32> = std::collections::HashSet::new();
        for (n, _) in &want {
            if !indexed.insert(*n) {
                continue;
            }
            for (i, c) in self.nodes[*n as usize].columns.iter().enumerate() {
                slot.insert((*n, c.name.to_lowercase()), i as u32);
            }
        }

        // 3. Edges.
        let mut kinds: Vec<String> = Vec::new();
        let mut edges: Vec<ColEdge> = Vec::with_capacity(raw.edges.len());
        for e in &raw.edges {
            let (Some(&fi), Some(&ti)) = (self.index.get(e.from.as_str()), self.index.get(e.to.as_str())) else {
                continue;
            };
            let (Some(&fc), Some(&tc)) = (
                slot.get(&(fi, e.from_col.to_lowercase())),
                slot.get(&(ti, e.to_col.to_lowercase())),
            ) else {
                dropped += 1;
                continue;
            };
            let kind = match kinds.iter().position(|k| *k == e.kind) {
                Some(i) => i,
                None => {
                    kinds.push(e.kind.clone());
                    kinds.len() - 1
                }
            };
            edges.push(ColEdge {
                from: ColRef { node: fi, col: fc },
                to: ColRef { node: ti, col: tc },
                kind: kind.min(255) as u8,
            });
            if edges.len() >= MAX_EDGES {
                eprintln!("  column lineage capped at {MAX_EDGES} edges");
                break;
            }
        }

        edges.sort_by(|a, b| (a.from, a.to).cmp(&(b.from, b.to)));
        edges.dedup_by(|a, b| a.from == b.from && a.to == b.to);
        let mut by_to: Vec<u32> = (0..edges.len() as u32).collect();
        by_to.sort_by_key(|&i| edges[i as usize].to);

        let total = edges.len();
        let mut breakdown: Vec<KindCount> = kinds
            .iter()
            .enumerate()
            .map(|(i, k)| KindCount {
                kind: if k.is_empty() { "unknown".into() } else { k.clone() },
                edges: edges.iter().filter(|e| e.kind as usize == i).count(),
            })
            .collect();
        breakdown.sort_by(|a, b| b.edges.cmp(&a.edges));
        self.meta.cll_kinds = breakdown;
        self.cll = Some(ColLineage { edges, by_to, kinds });
        self.meta.cll_edges = total;
        self.meta.cll_dropped = dropped;
        self.meta.cll_mtime = mtime;
        self.meta.cll_source = raw.source;
        self.meta.cll_target = raw.target;
        self.meta.cll_generated_at = raw.generated_at;
        total
    }

    /// Column-level BFS, the exact mirror of `lineage()` one level down.
    pub fn column_lineage(&self, focus: ColRef, up: u32, down: u32, max_nodes: usize) -> Lineage<'_> {
        // The handler already refuses this case; the guard keeps the borrow of
        // `cll` tied to `self` so the returned Lineage can reference its kinds.
        let Some(cll) = self.cll.as_ref() else {
            return Lineage {
                focus: 0,
                truncated: false,
                mode: "column",
                focus_column: "",
                nodes: Vec::new(),
                edges: Vec::new(),
                edge_kinds: Vec::new(),
            };
        };
        let mut depth: HashMap<ColRef, i32> = HashMap::new();
        let mut truncated = false;
        depth.insert(focus, 0);

        for (limit, upstream) in [(up, true), (down, false)] {
            let mut frontier = vec![focus];
            for step in 1..=limit as i32 {
                let mut next = Vec::new();
                for &cur in &frontier {
                    let neighbours: Vec<ColRef> = if upstream {
                        cll.incoming(cur).map(|e| e.from).collect()
                    } else {
                        cll.outgoing(cur).iter().map(|e| e.to).collect()
                    };
                    for nb in neighbours {
                        if depth.len() >= max_nodes {
                            truncated = true;
                            break;
                        }
                        if let std::collections::hash_map::Entry::Vacant(v) = depth.entry(nb) {
                            v.insert(if upstream { -step } else { step });
                            next.push(nb);
                        }
                    }
                }
                if next.is_empty() || truncated {
                    break;
                }
                frontier = next;
            }
        }

        let mut members: Vec<ColRef> = depth.keys().copied().collect();
        members.sort_unstable();
        let pos: HashMap<ColRef, usize> = members.iter().enumerate().map(|(p, &c)| (c, p)).collect();

        let mut pairs: Vec<([usize; 2], u8)> = Vec::new();
        for (p, &c) in members.iter().enumerate() {
            for e in cll.outgoing(c) {
                if let Some(&q) = pos.get(&e.to) {
                    pairs.push(([p, q], e.kind));
                }
            }
        }
        pairs.sort_unstable();
        pairs.dedup_by(|a, b| a.0 == b.0);
        let edges: Vec<[usize; 2]> = pairs.iter().map(|(e, _)| *e).collect();
        let edge_kinds: Vec<&str> = pairs
            .iter()
            .map(|(_, k)| cll.kinds.get(*k as usize).map(String::as_str).unwrap_or(""))
            .collect();

        let focus_node = &self.nodes[focus.node as usize];
        Lineage {
            focus: pos[&focus],
            truncated,
            mode: "column",
            edge_kinds,
            focus_column: focus_node.columns.get(focus.col as usize).map(|c| c.name.as_str()).unwrap_or(""),
            nodes: members
                .iter()
                .map(|&c| {
                    let owner = &self.nodes[c.node as usize];
                    let column = &owner.columns[c.col as usize];
                    let (up_n, down_n) = cll.degree(c);
                    let mut sub = owner.name.clone();
                    if !column.data_type.is_empty() {
                        sub.push_str("  ·  ");
                        sub.push_str(&column.data_type);
                    }
                    LineageNode {
                        id: std::borrow::Cow::Owned(format!("{}::{}", owner.id, column.name)),
                        name: &column.name,
                        kind: owner.kind,
                        file: &owner.file,
                        schema: &owner.schema,
                        materialized: &owner.materialized,
                        disabled: owner.disabled,
                        depth: depth[&c],
                        sub,
                        tests: column.tests.len(),
                        parents: up_n,
                        children: down_n,
                        hidden_up: cll.incoming(c).filter(|e| !pos.contains_key(&e.from)).count(),
                        hidden_down: cll.outgoing(c).iter().filter(|e| !pos.contains_key(&e.to)).count(),
                    }
                })
                .collect(),
            edges,
        }
    }

    /// Folds catalog.json into the graph: fills in missing data types and adds
    /// the warehouse columns that are not declared in YAML.
    pub fn merge_catalog(&mut self, cat: RawCatalog, mtime: u64) -> usize {
        let mut touched = 0;
        for (id, entry) in cat.nodes.into_iter().chain(cat.sources) {
            let Some(&i) = self.index.get(&id) else { continue };
            let node = &mut self.nodes[i as usize];
            for (_, col) in entry.columns {
                let key = col.name.to_lowercase();
                match node.columns.iter_mut().find(|c| c.name.to_lowercase() == key) {
                    Some(existing) => {
                        if existing.data_type.is_empty() {
                            existing.data_type = col.r#type.clone();
                        }
                        if existing.description.is_empty() {
                            existing.description = col.comment.clone().unwrap_or_default();
                        }
                    }
                    None => node.columns.push(Column {
                        name: col.name,
                        data_type: col.r#type,
                        description: col.comment.unwrap_or_default(),
                        tests: Vec::new(),
                        undeclared: true,
                    }),
                }
                touched += 1;
            }
            node.columns.sort_by(|a, b| a.name.cmp(&b.name));
        }
        self.catalog_mtime = mtime;
        touched
    }

    /// Transitive upstream/downstream counts, tests excluded.
    pub fn reach(&self, start: u32, upstream: bool) -> usize {
        let mut seen = std::collections::HashSet::new();
        let mut stack = vec![start];
        while let Some(cur) = stack.pop() {
            let side = if upstream { &self.nodes[cur as usize].parents } else { &self.nodes[cur as usize].children };
            for &nb in side {
                if self.nodes[nb as usize].kind.is_graph_node() && seen.insert(nb) {
                    stack.push(nb);
                }
            }
        }
        seen.len()
    }

    /// Ranked substring search over node names and file paths.
    pub fn search(&self, query: &str, kinds: &[Kind], limit: usize) -> Vec<u32> {
        let q = query.trim().to_lowercase();
        let mut hits: Vec<(u32, u32)> = Vec::new(); // (score, index) - lower score is better
        for (i, n) in self.nodes.iter().enumerate() {
            if !kinds.is_empty() && !kinds.contains(&n.kind) {
                continue;
            }
            let score = if q.is_empty() {
                50
            } else {
                let (name_key, path_key) = n.search_key.split_once('\u{0}').unwrap_or((&n.search_key, ""));
                if name_key == q {
                    0
                } else if name_key.starts_with(&q) {
                    10
                } else if name_key.contains(&q) {
                    20
                } else if path_key.contains(&q) {
                    30
                } else {
                    continue;
                }
            };
            hits.push((score * 1_000_000 + n.name.len().min(999) as u32 * 1000, i as u32));
        }
        hits.sort_unstable();
        hits.truncate(limit);
        hits.into_iter().map(|(_, i)| i).collect()
    }

    /// Breadth-first upstream/downstream expansion around a focus node.
    pub fn lineage(&self, focus: u32, up: u32, down: u32, with_tests: bool, max_nodes: usize) -> Lineage<'_> {
        let mut depth: HashMap<u32, i32> = HashMap::new();
        let mut truncated = false;
        depth.insert(focus, 0);

        for (limit, upstream) in [(up, true), (down, false)] {
            let mut frontier = vec![focus];
            for step in 1..=limit as i32 {
                let mut next = Vec::new();
                for &cur in &frontier {
                    let node = &self.nodes[cur as usize];
                    let neighbours = if upstream { &node.parents } else { &node.children };
                    for &nb in neighbours {
                        if !self.nodes[nb as usize].kind.is_graph_node() {
                            continue;
                        }
                        if depth.len() >= max_nodes {
                            truncated = true;
                            break;
                        }
                        let d = if upstream { -step } else { step };
                        if let std::collections::hash_map::Entry::Vacant(e) = depth.entry(nb) {
                            e.insert(d);
                            next.push(nb);
                        }
                    }
                }
                if next.is_empty() || truncated {
                    break;
                }
                frontier = next;
            }
        }

        if with_tests {
            let members: Vec<u32> = depth.keys().copied().collect();
            for m in members {
                let d = depth[&m];
                for &t in &self.nodes[m as usize].tests {
                    if depth.len() >= max_nodes {
                        truncated = true;
                        break;
                    }
                    depth.entry(t).or_insert(d);
                }
            }
        }

        let mut members: Vec<u32> = depth.keys().copied().collect();
        members.sort_unstable();
        let pos: HashMap<u32, usize> = members.iter().enumerate().map(|(p, &i)| (i, p)).collect();

        let mut edges: Vec<[usize; 2]> = Vec::new();
        for (p, &i) in members.iter().enumerate() {
            let node = &self.nodes[i as usize];
            for &c in &node.children {
                if let Some(&cp) = pos.get(&c) {
                    edges.push([p, cp]);
                }
            }
            if with_tests {
                for &t in &node.tests {
                    if let Some(&tp) = pos.get(&t) {
                        edges.push([p, tp]);
                    }
                }
            }
        }
        edges.sort_unstable();
        edges.dedup();

        Lineage {
            focus: pos[&focus],
            truncated,
            mode: "model",
            focus_column: "",
            edge_kinds: Vec::new(),
            nodes: members
                .iter()
                .map(|&i| {
                    let n = &self.nodes[i as usize];
                    LineageNode {
                        id: std::borrow::Cow::Borrowed(&n.id),
                        name: &n.name,
                        sub: String::new(),
                        kind: n.kind,
                        file: &n.file,
                        schema: &n.schema,
                        materialized: &n.materialized,
                        disabled: n.disabled,
                        depth: depth[&i],
                        tests: n.tests.len(),
                        parents: n.parents.len(),
                        children: n.children.len(),
                        hidden_up: n.parents.iter().filter(|p| !pos.contains_key(p)).count(),
                        hidden_down: n.children.iter().filter(|c| !pos.contains_key(c)).count(),
                    }
                })
                .collect(),
            edges,
        }
    }
}

#[derive(serde::Serialize)]
pub struct Lineage<'a> {
    pub focus: usize,
    pub truncated: bool,
    pub mode: &'static str,
    #[serde(skip_serializing_if = "str::is_empty")]
    pub focus_column: &'a str,
    pub nodes: Vec<LineageNode<'a>>,
    pub edges: Vec<[usize; 2]>,
    /// Column mode: one kind per edge, same order as `edges`. A renderer can
    /// destructure `edges` as a pair and ignore this entirely.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub edge_kinds: Vec<&'a str>,
}

#[derive(serde::Serialize)]
pub struct LineageNode<'a> {
    pub id: std::borrow::Cow<'a, str>,
    pub name: &'a str,
    pub kind: Kind,
    pub file: &'a str,
    pub schema: &'a str,
    pub materialized: &'a str,
    pub disabled: bool,
    pub depth: i32,
    /// Column mode only: the second line of the node box.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub sub: String,
    pub tests: usize,
    pub parents: usize,
    pub children: usize,
    pub hidden_up: usize,
    pub hidden_down: usize,
}
