# Cortex Index Contract

Status: v3.1. Binding for all ai-* consumers (ai-whisper, ai-14all, ai-samantha).

## 1. Versioning policy

SemVer-style `major.minor`. Additive optional fields are a minor bump. Shape or
meaning changes, field removal, or rename are a major bump. Cache invalidation
keys off the major version only: a reader on the same major reads any minor as-is.

## 2. Reader rules

- MUST tolerate missing optional fields.
- MUST tolerate unknown future optional fields.
- MUST NOT depend on JSON key iteration order.
- SHOULD pin against the major version and accept any minor at or above the one
  they were written against.

## 3. Coordinate conventions

All line and column numbers are 1-indexed. All ranges are inclusive on both ends.
Source is tree-sitter `startPosition`/`endPosition`, converted as: line/column =
`startPosition.row|column + 1`; endLine = `endPosition.row + 1`; endColumn =
`endPosition.column` (tree-sitter's exclusive 0-indexed end equals the inclusive
1-indexed end).

## 4. Canonical symbol identity (today)

Within one index snapshot the canonical function identifier is
`${file}::${qualifiedName}`, the form used in `CallEdge.from` and `CallEdge.to`.
Unique within a snapshot. NOT stable across file rename, function rename, or
refactor. Consumers needing cross-session stable references must track separately.

## 5. Reserved fields

`FunctionNode.id?: string` is reserved for a future rename-stable symbol ID.
Writers at v3.x MUST NOT emit it. Readers MUST tolerate its presence in future
minors.

## 6. Range semantics for special cases

- `isDeclarationOnly: true`: range covers the signature only, no body.
- Unresolved calls (`to` starts with `"::"`): `site` MAY still be present and
  refers to the callsite in the caller's file.
- Multi-line callsites: the range covers the entire call expression node, from
  the start of the callee expression to the closing paren of the argument list.

## 7. Storage shape reference

Cache path: `~/.cache/ai-cortex/v1/<repoKey>/<worktreeKey>.db` — a per-worktree
SQLite database (WAL mode, `PRAGMA user_version` for the store-format version),
with a small `<worktreeKey>.meta.json` sidecar carrying dashboard metadata
(name, fileCount, indexedAt, fingerprint, worktreePath). The structural graph is
stored as rows: `files`, `docs`, `imports`, `functions`, `calls`, plus a `meta`
key/value table for scalar fields. `CallEdge.site` is four nullable INTEGER
columns on `calls` (`site_line`, `site_col`, `site_end_line`, `site_end_col`);
`FunctionNode` ranges are nullable INTEGER columns on `functions` (`col`,
`end_line`, `end_col`) and the reserved `id` is a nullable TEXT column. The
directory `v1` is a filesystem-layout version, separate from the content schema
version; reconciling the two is a candidate for a future major bump. (Legacy
`<worktreeKey>.json` caches are transcoded to `.db` in place on first read.)
