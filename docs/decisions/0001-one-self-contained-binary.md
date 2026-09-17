# 0001. One self-contained binary, written in Rust

Date: 2026-09-10 · Status: accepted

**Trigger:** read before adding a runtime dependency, a packaging step, or
anything the user would have to install.

## Context

The tool has to run in two places: a Mac, and a locked-down Windows VM where
the user can run code but cannot install applications. That single constraint
decides more of this codebase than any preference about languages.

## Decision

Ship one executable that contains the server, the frontend and everything else.
Copy it to the VM, run it, open a browser. No installer, no runtime, no
`PATH` entry, no admin prompt. Rust gives a static binary that cross-compiles
to `x86_64-pc-windows-gnu` from the Mac (see `.cargo/config.toml`).

## Rejected

- **Electron or Tauri.** Both want an installer, and Tauri needs a WebView2
  runtime that may not be present.
- **Python plus pip.** Installing packages is exactly what the VM refuses.
- **A static site with no server.** No PTY, no filesystem, no git.
- **A VS Code extension.** Requires VS Code and the right to add extensions.

## Consequences

Anything that cannot be compiled in is out, which rules out talking to a
warehouse (see 0008) and any frontend build step (see 0004). Release builds
strip and use thin LTO to keep the binary near 4 MB.
