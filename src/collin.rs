//! The column-lineage cache written by `tools/sf_lineage.py`.
//!
//! Deliberately source agnostic: the same file shape can later be filled from
//! dbt Fusion's parquet index instead of Snowflake, without touching the graph.

use std::path::Path;

#[derive(serde::Deserialize, Default)]
pub struct RawColLineage {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub generated_at: String,
    #[serde(default)]
    pub edges: Vec<RawColEdge>,
}

#[derive(serde::Deserialize)]
pub struct RawColEdge {
    /// dbt unique_id, or `rel:<db.schema.object>` for something dbt does not own.
    pub from: String,
    pub from_col: String,
    pub to: String,
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
}
