# 0015. The browser is not trusted: Host and Origin are checked

Date: 2026-09-17 · Status: accepted

**Trigger:** read before adding a route, changing the port logic, or adding a
CORS header.

## Context

The server binds to `127.0.0.1` (0012), which keeps other machines out. It does
nothing against other web pages in the same browser, and a security audit on
2026-09-17 confirmed three attacks against a running instance:

- any page can open `ws://127.0.0.1:4321/ws/pty` and get a shell, because
  browsers apply no same-origin policy to a WebSocket handshake;
- any page can POST to `/api/git/push`, `pull`, `fetch`, `merge-abort` and
  `/api/reload`, because a bodyless request needs no CORS preflight;
- by DNS rebinding, a page can become same-origin with the server and read the
  whole project through `/api/file`, `.env` included.

## Decision

One middleware in `src/api.rs`, `guard`, runs before every route:

- `Host` must be exactly `127.0.0.1:<port>` or `localhost:<port>`, where the
  port is the one actually bound, not the one asked for.
- Any request that is not a plain GET or HEAD must carry a matching `Origin`
  if it carries one at all. A WebSocket handshake must carry one: browsers
  always send it there, so its absence is never a browser.
- No CORS header is ever added, so a plain GET stays unreadable cross-site.
- Every reply carries a content security policy, `nosniff` and `no-referrer`.
  The policy allows nothing from another origin, which the frontend never
  needed (0004), and `frame-ancestors 'none'` closes clickjacking: framing is
  a navigation, so it carries no `Origin` for the guard to judge.

`/api/git/diff` reads from disk, so its path goes through `files::resolve`
like the editor's, rather than the lighter check the git actions keep.

## Rejected

- **A random token in the URL**, as Jupyter does. It breaks the printed link,
  every bookmark and every reopened tab, for a check the two headers give.
- **Relying on the loopback bind alone.** It was the state of things, and it
  protects nothing from the browser.
- **A CSRF token per request.** There is no form to carry one, and every
  handler would have to check it. A middleware forgets nothing.

## Consequences

A new route is covered without doing anything. `curl` still works for reads
and for bodyless POSTs, since a missing `Origin` marks a local tool, never a
browser. Reaching the server through any other name than `127.0.0.1` or
`localhost`, including a tunnel, gets a `403`. The editor keeps reading `.env`
files: 0012 is about what the environments feature returns, not about the
editor, and `SECURITY.md` says so.
