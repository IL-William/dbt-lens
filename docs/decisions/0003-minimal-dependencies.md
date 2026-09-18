# 0003. A deliberately small dependency list

Date: 2026-09-10 · Status: accepted

**Trigger:** read before adding any crate, and whenever hand-written parsing
looks like something a library should do.

## Context

`Cargo.toml` has ten direct dependencies and no HTTP client, no TLS stack, no
regex engine and no YAML parser. That is a choice, made repeatedly, not an
oversight.

## Decision

Add a crate only when it does something genuinely hard (a PTY across two
operating systems, an async HTTP server) and write the small stuff by hand:

- **No regex.** The patterns here are fixed and shallow: `env_var('X')`,
  conflict markers, `ref()` calls. Hand-written scanners in `src/envs.rs` and
  `web/app.js` are more readable at this size, and they report *where* they
  gave up instead of silently not matching.
- **No YAML parser.** The manifest holds the merged YAML for everything the
  graph needs. The one thing it does not hold is the `vars:` block, read by a
  hand-written scanner in `src/project.rs` (0016).
- **No HTTP client or TLS.** The server never calls anything outbound (0008).

## Rejected

`regex`, `serde_yaml`, `reqwest`: each one is build time on every machine, a
supply chain to trust, and binary size on a VM where the binary is copied by
hand.

## Consequences

Some functions are longer than their library equivalent would be. In exchange
the build is quick, the binary is small, and every parsing rule is visible and
unit-tested in this repository.
