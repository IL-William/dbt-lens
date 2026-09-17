//! Raw deserialization of a dbt `manifest.json`.
//!
//! Only the fields the UI needs are declared: serde drops everything else while
//! parsing, which keeps a 90 MB manifest from turning into a 1 GB object graph.

use std::collections::HashMap;

#[derive(serde::Deserialize, Default)]
pub struct RawManifest {
    #[serde(default)]
    pub metadata: RawMetadata,
    #[serde(default)]
    pub nodes: HashMap<String, RawNode>,
    #[serde(default)]
    pub sources: HashMap<String, RawNode>,
    #[serde(default)]
    pub exposures: HashMap<String, RawNode>,
    #[serde(default)]
    pub parent_map: HashMap<String, Vec<String>>,
    /// Nodes dbt parsed but left out of the graph. Their files still exist, so
    /// the editor must be able to jump to them.
    #[serde(default)]
    pub disabled: HashMap<String, Vec<RawNode>>,
}

#[derive(serde::Deserialize, Default)]
pub struct RawMetadata {
    #[serde(default)]
    pub dbt_version: String,
    #[serde(default)]
    pub project_name: String,
    #[serde(default)]
    pub generated_at: String,
    #[serde(default)]
    pub adapter_type: String,
}

#[derive(serde::Deserialize)]
pub struct RawNode {
    pub name: String,
    pub resource_type: String,
    #[serde(default)]
    pub package_name: String,
    #[serde(default)]
    pub original_file_path: String,
    #[serde(default)]
    pub patch_path: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub source_name: Option<String>,
    #[serde(default)]
    pub alias: Option<String>,
    /// Sources only: the table name in the warehouse.
    #[serde(default)]
    pub identifier: Option<String>,
    /// Sources only: database and schema exactly as written, Jinja included.
    #[serde(default)]
    pub unrendered_database: Option<String>,
    #[serde(default)]
    pub unrendered_schema: Option<String>,
    /// Models: config as written, before env vars and macros are evaluated.
    #[serde(default)]
    pub unrendered_config: RawPlaceConfig,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub relation_name: Option<String>,
    #[serde(default)]
    pub config: RawConfig,
    #[serde(default)]
    pub columns: HashMap<String, RawColumn>,
    #[serde(default)]
    pub depends_on: RawDependsOn,
    // Test-only fields, used to attach a test to the column it guards.
    #[serde(default)]
    pub column_name: Option<String>,
    #[serde(default)]
    pub attached_node: Option<String>,
    #[serde(default)]
    pub test_metadata: Option<RawTestMeta>,
}

#[derive(serde::Deserialize, Default)]
pub struct RawTestMeta {
    #[serde(default)]
    pub name: String,
}

#[derive(serde::Deserialize, Default)]
pub struct RawConfig {
    #[serde(default)]
    pub materialized: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub incremental_strategy: Option<String>,
    #[serde(default)]
    pub unique_key: Option<serde_json::Value>,
    #[serde(default)]
    pub database: Option<serde_json::Value>,
    #[serde(default)]
    pub schema: Option<serde_json::Value>,
    #[serde(default)]
    pub alias: Option<serde_json::Value>,
}

/// The three location keys, and nothing else, out of `unrendered_config`.
#[derive(serde::Deserialize, Default)]
pub struct RawPlaceConfig {
    #[serde(default)]
    pub database: Option<serde_json::Value>,
    #[serde(default)]
    pub schema: Option<serde_json::Value>,
    #[serde(default)]
    pub alias: Option<serde_json::Value>,
}

#[derive(serde::Deserialize, Default)]
pub struct RawColumn {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub data_type: Option<String>,
}

#[derive(serde::Deserialize, Default)]
pub struct RawDependsOn {
    #[serde(default)]
    pub nodes: Vec<String>,
}

/// `catalog.json`, written by `dbt docs generate`. Optional: it carries the real
/// warehouse column types, which the manifest only has when declared in YAML.
#[derive(serde::Deserialize, Default)]
pub struct RawCatalog {
    #[serde(default)]
    pub nodes: HashMap<String, CatalogNode>,
    #[serde(default)]
    pub sources: HashMap<String, CatalogNode>,
}

#[derive(serde::Deserialize, Default)]
pub struct CatalogNode {
    #[serde(default)]
    pub columns: HashMap<String, CatalogColumn>,
}

#[derive(serde::Deserialize, Default)]
pub struct CatalogColumn {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub r#type: String,
    #[serde(default)]
    pub comment: Option<String>,
}

impl RawCatalog {
    pub fn load(path: &std::path::Path) -> anyhow::Result<Self> {
        let bytes = std::fs::read(path)?;
        Ok(serde_json::from_slice(&bytes)?)
    }
}

impl RawManifest {
    pub fn load(path: &std::path::Path) -> anyhow::Result<Self> {
        let bytes = std::fs::read(path)?;
        Ok(serde_json::from_slice(&bytes)?)
    }
}
