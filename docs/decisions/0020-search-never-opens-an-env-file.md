# 0020. A content search never opens a `.env` file

Date: 2026-09-18 · Status: accepted

**Trigger:** read before making the server read files it was not asked for by
name.

## Context

`Cmd/Ctrl + K` searched two things by name: dbt nodes, and a flat index of every
file. Neither reads a file, so neither could find a column that appears in forty
models, which reads as the search being broken rather than as it answering a
different question.

Answering it means the server opens every indexed file. SECURITY.md says the
editor reads the whole project, `.env` included, and that is what an editor is
for. But opening one file because the user asked for that file is not the same
act as reading all of them because they typed a word.

## Decision

The content search skips `.env` and `.env.*`, and nothing else. Everything the
path index already excludes stays excluded, since it walks that same index.

A search is a wide, undirected read whose results land in a list, in a payload
and in the browser's memory. A user who wants to see a `.env` opens it, and the
editor shows it, unchanged. What 0019 allows is a value the user pointed at;
this is the opposite shape of request.

## Rejected

- **Searching them and redacting the matching line.** The file name and the line
  number would still say where a secret is, and the redaction would be one more
  guard to get right on a path that does not need to exist.
- **A setting to include them.** A setting that turns off a safety guard is a
  setting that gets turned off, which 0019 already found.
- **Extending `sensitive_name` to the line.** It guesses from a variable's name,
  which is the right shape for one value the user asked about and the wrong one
  for a whole file.

## Consequences

Searching for a variable's name finds where it is *used*, in models and in
`dbt_project.yml`, and never where it is *set*. That is usually the question,
and the environment panel already answers the other one by name.
