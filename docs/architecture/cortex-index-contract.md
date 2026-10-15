# Cortex Index Contract

Status: v3.2. Binding for all ai-* consumers (ai-whisper, ai-14all, ai-samantha).

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

## 4. Canonical symbol identity

Within one index snapshot the canonical symbol identifier is
`${file}::${qualifiedName}`, the form used in `CallEdge.from`, `CallEdge.to`,
`symbols.key`, `refs.to_key`, and `refs.from_key`. NOT stable across file
rename, symbol rename, or refactor. Consumers needing cross-session stable
references must track separately.

`qualified_name` is the container path joined with `.` in every language. It
never contains `::`. v3.2 corrected the C-family adapter, which previously
emitted `Foo::bar` and `ns::fn`; those keys are now `Foo.bar` and `ns.fn`.
`symbols.key` uses the same form. `functions` has exactly one row per key;
`symbols` may hold several rows per key (overloads, `declare` plus
implementation, re-opened namespaces), and readers prefer rows with
`is_declaration_only = 0`.

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

Cache path: `~/.cache/ai-cortex/v1/<repoKey>/<worktreeKey>.db`, a per-worktree
SQLite database (WAL mode, `PRAGMA user_version = 2` for the store-format
version), with a small `<worktreeKey>.meta.json` sidecar carrying dashboard
metadata (name, fileCount, indexedAt, fingerprint, worktreePath) and a
`<worktreeKey>.seq.db` sequence sidecar (plus its transient
`<worktreeKey>.seq.db-journal` while a write is in flight) that serializes
`indexSeq` assignment across processes. The sequence sidecar is a rollback-journal
SQLite database holding one row; it is never deleted by ai-cortex's own
invalidation, so numbering continues across store-format resets.

The structural graph is stored as rows: `files`, `docs`, `imports`, `functions`,
`calls`, `symbols`, `refs`, and the writer-internal `reexports`, plus a `meta`
key/value table for scalar fields. `CallEdge.site` is four nullable INTEGER
columns on `calls` (`site_line`, `site_col`, `site_end_line`, `site_end_col`);
`FunctionNode` ranges are nullable INTEGER columns on `functions` (`col`,
`end_line`, `end_col`) and the reserved `id` is a nullable TEXT column. The
directory `v1` is a filesystem-layout version, separate from the content schema
version; reconciling the two is a candidate for a future major bump.

### `symbols`

One row per jumpable declaration.

```sql
CREATE TABLE symbols (
  key                 TEXT    NOT NULL,  -- `${file}::${qualified_name}`
  file                TEXT    NOT NULL,  -- repo-relative POSIX path
  qualified_name      TEXT    NOT NULL,  -- container path joined with '.'
  name                TEXT    NOT NULL,  -- identifier text of the name node
  kind                TEXT    NOT NULL,  -- Appendix A
  container_key       TEXT,              -- key of enclosing symbol, NULL at module scope
  exported            INTEGER NOT NULL,  -- 0 | 1
  is_default_export   INTEGER NOT NULL,  -- 0 | 1
  is_declaration_only INTEGER NOT NULL,  -- 0 | 1
  line                INTEGER NOT NULL,  -- declaration range, 1-indexed inclusive
  col                 INTEGER NOT NULL,
  end_line            INTEGER NOT NULL,
  end_col             INTEGER NOT NULL,
  name_line           INTEGER NOT NULL,  -- identifier range, the jump target
  name_col            INTEGER NOT NULL,
  name_end_line       INTEGER NOT NULL,
  name_end_col        INTEGER NOT NULL
);
-- indexes: idx_symbols_key(key), idx_symbols_name(name), idx_symbols_file(file)
```

### `refs`

Identifier occurrences that name a symbol. The table is named `refs` because
`REFERENCES` is a reserved word in SQLite; `meta.navCapabilities.referencesTable`
carries the name.

```sql
CREATE TABLE refs (
  file      TEXT    NOT NULL,  -- file containing the occurrence
  name      TEXT    NOT NULL,  -- identifier text at the site
  kind      TEXT    NOT NULL,  -- Appendix A
  line      INTEGER NOT NULL,  -- identifier token range, 1-indexed inclusive
  col       INTEGER NOT NULL,
  end_line  INTEGER NOT NULL,
  end_col   INTEGER NOT NULL,
  to_key    TEXT,              -- resolved symbols.key, NULL when unresolved
  from_key  TEXT               -- enclosing symbols.key, NULL at module scope
);
-- indexes: idx_refs_to(to_key), idx_refs_name(name), idx_refs_file(file, line)
```

### `reexports` (writer-internal)

Persists each file's named re-exports so one-hop resolution survives
incremental indexing. Consumers may ignore it; `navCapabilities` does not
advertise it.

```sql
CREATE TABLE reexports (
  file          TEXT NOT NULL,  -- file containing the export-from statement
  exported_name TEXT NOT NULL,  -- name visible to importers
  source_name   TEXT NOT NULL,  -- name in the source module
  specifier     TEXT NOT NULL   -- raw specifier text as written
);
-- index: idx_reexports_file(file, exported_name)
```

One row per named export-from specifier; `export * from` produces no row.

### `meta` keys added in 3.2

| key | Value | Meaning |
|---|---|---|
| `schemaVersion` | `"3.2"` | Content contract version. |
| `navCapabilities` | JSON | `{"symbols":true,"references":true,"referencesTable":"refs","symbolKinds":[...],"referenceKinds":[...]}`. The union of kinds the registered adapters can emit (static per adapter, not observed in this repo). A 3.2 writer always emits it. |
| `indexSeq` | integer as text | Increases on every successful write, full or incremental, including the empty-diff timestamp-only refresh and dirty-worktree reindexes under an unchanged `fingerprint`. Every successful write publishes a value strictly greater than the previous one for that store path. A path with no prior store and no sidecar starts at `1`. |
| `contentFingerprint` | hex text | sha1 over sorted `(path, content_hash)` pairs of `files`, joined with newlines. Unchanged when only `indexedAt` moves, so a consumer can skip re-ingest when content is the same even though `indexSeq` moved. |

`fingerprint` (the git HEAD), `indexedAt`, and `dirtyAtIndex` are unchanged.

### Version gates

ai-cortex's own readers require an exact `meta.schemaVersion` match and reject
legacy `.json` caches whose `schemaVersion` is not exactly current; consumer
readers keep the major-only rule from section 1. A `.db` whose `user_version`
is not `2` is discarded and rebuilt on first use. Legacy
`<worktreeKey>.json` caches whose `schemaVersion` is exactly current are
transcoded to `.db` in place on first read; any other legacy JSON is deleted
and the caller reindexes.

## 8. Navigation index (v3.2)

Readers detect the navigation index via `meta.navCapabilities`; when it is
absent they fall back to `functions`.

### `symbols` rules

- `key` is not unique. Overloads, `declare` plus implementation pairs, and
  re-opened namespaces produce several rows with one key. Readers prefer rows
  with `is_declaration_only = 0`.
- `qualified_name` never contains `::`.
- `name` is the name node text. Computed or string-literal member names use the
  unquoted literal. Anonymous declarations are not emitted, except
  `export default <anonymous fn/class>`: `qualified_name = "default"`,
  `name = "default"`, and the name range is the range of the `default` keyword.
- Scope: module scope plus members directly inside `class`, `interface`,
  `enum`, `namespace`, and object type bodies. Function-local declarations and
  parameters are not emitted.
- `functions` is a one-row-per-key projection of `symbols` filtered to kinds
  `function`, `method`, `class`: the first row with `is_declaration_only = 0`
  in source order, else the first declaration-only row. Every `functions` row
  has a `symbols` row with the same key, `file`, `qualified_name`, declaration
  range, `exported`, `is_default_export`, and `is_declaration_only`. The
  converse does not hold.

### `refs` rules

- Unresolved refs carry `to_key = NULL` and the identifier in `name`. This
  differs deliberately from `calls.to_key = '::name'`, which stays as-is for
  3.1 compatibility.
- The range is the identifier token. For `a.b.c` it is the `c` token.
- `name` is always the text of the token at the range. Import and export forms:

  | Form | `name` | range | resolves to |
  |---|---|---|---|
  | `import { foo } from "./x"` | `foo` | the `foo` token | symbol `foo` in `./x` |
  | `import { foo as bar } from "./x"` | `foo` | the `foo` token | symbol `foo` in `./x` |
  | `import Foo from "./x"` | `Foo` | the `Foo` token | the `is_default_export = 1` symbol in `./x` |
  | `import * as ns from "./x"` | `ns` | the `ns` token | `NULL` (a module is not a symbol) |
  | `export { foo } from "./x"` | `foo` | the `foo` token | symbol `foo` in `./x` |
  | `export { foo as bar } from "./x"` | `foo` | the `foo` token | symbol `foo` in `./x` |
  | `export { foo }` (local) | `foo` | the `foo` token | same-file `foo` |
  | `export * from "./x"` | no row | | star re-exports are not recorded and not followed |
  | `import "./x"` (side effect) | no row | | |

  The default and namespace forms have no imported-name token, so their row
  names the local binding.
- A declaration's own name is not a ref.
- The row set is deterministic for a given file content.

### Resolution rules

Shared by `refs.to_key` and `calls.to_key`. Syntactic, first hit wins:

1. **Enclosing-class member.** `this.m`, `self.m`, `cls.m` inside a class body,
   or `Class.m` written literally where `Class` is the enclosing class,
   resolves to `${file}::${enclosingClass}.${m}`, where `enclosingClass` is the
   fully qualified name of the innermost enclosing class (`N.C` for
   `namespace N { class C { ... } }`). Inherited members are not followed in
   3.2 and fall through.
2. **Same-file bare match.** `name` equals a module-scope `qualified_name` in
   the same file.
3. **Import binding.** A ref of kind `import` resolves directly: named imports
   to the symbol with `qualified_name = name` in the target file (the imported
   name, not the alias), default imports to the unique `is_default_export = 1`
   symbol, namespace imports to `NULL`. Any other ref whose `name` (or
   receiver, for `receiver.member`) equals an import binding's local name
   resolves through the binding's imported name: named import, that symbol in
   the target file; default import, the default export; namespace import, the
   member in the target file. Re-exports are followed one hop through the
   `reexports` table (`export { foo as bar } from "./x"` maps wanted `bar` to
   `foo` in `./x`). Star re-exports are not followed.
4. **Static member on an imported or same-file class.** `Foo.bar` where `Foo`
   resolves (steps 2 or 3) to a `class`, `enum`, or `namespace` symbol resolves
   to `${thatFile}::Foo.bar`.
5. Otherwise `NULL` for refs, `::member` for calls.

If a step yields more than one candidate (overloads aside, which share a key),
the ref is left unresolved.

Invariants and limits consumers should rely on:

- A non-null `refs.to_key` and any `calls.to_key` not starting with `::` name a
  key present in `symbols`. Stale keys pointing at a deleted or moved symbol
  are a contract violation.
- `calls.to_key` may name any `symbols` key, including module-level variables
  (for example a call to `const execAsync = promisify(exec)`), because step 2
  has no kind restriction. Consumers that join `calls` to `functions` will not
  see those edges; join to `symbols` instead.
- `calls.from_key` may also name any `symbols` key, not only a `functions`
  key: a call in a namespace or class body, or in a module-level variable
  initializer inside a container (`export const v = foo()` inside
  `namespace N`), is attributed to that enclosing container (`a.ts::N`).
  Consumers that join `calls` to `functions` on `from_key` will not see those
  rows; join to `symbols` instead.
- `refs` kinds `read` and `write` are not emitted.
- Writers keep every table consistent in one snapshot: `symbols`, `refs`,
  `reexports`, `functions`, `calls`, `imports`, `files`, and `meta` are replaced
  in one transaction, and the published `indexSeq` is stamped before the
  atomic rename, so readers of the canonical path only see whole snapshots.

## 9. CLI contract

1. Unknown flags on `index` or `rehydrate` print `ai-cortex: unknown flag: --name`
   and the subcommand usage to stderr and exit `2`; nothing is printed to stdout
   and no index runs. `--help` and `-h` print the usage to stdout and exit `0`
   without indexing.
2. Exit codes: `0` on success (including a `fresh` cache). `2` for usage
   errors (stderr starts with `ai-cortex: unknown flag:` and includes the usage
   block) and also for index failures (stderr starts with
   `ai-cortex: index failed:`). `1` for repository-identity errors (stderr
   starts with `ai-cortex:`). Any other unexpected exception is rethrown and
   Node exits non-zero with a stack trace. Any non-zero code is a failure;
   distinguish usage errors from index failures by the stderr prefix, not by
   the code.
3. `index --json` prints one object with these fields: `cacheStatus`,
   `packageName`, `fileCount`, `docCount`, `dbPath`, `schemaVersion`,
   `fingerprint`, `contentFingerprint`, `indexSeq`, `indexedAt`,
   `dirtyAtIndex`. `rehydrate --json` prints the same object plus
   `briefingPath`.
4. `cacheStatus` is `"fresh"` (the existing store was served), `"reindexed"`
   (a new snapshot was written), or `"stale"` (`rehydrate --stale` served an
   out-of-date store without writing). `index` has no `--stale` flag, so its
   value is `"fresh"` or `"reindexed"`; `index --refresh` always reports
   `"reindexed"`.
5. The human output of `index` prints the `.db` store path.

## 10. Acceptance measurement

The release gate (`scripts/acceptance-v3.2.sh <ai-14all-worktree>`) measures
resolution over refs of kind `call`, `new`, `type`, or `import` whose `name` is
defined as a symbol in the indexed repository
(`name IN (SELECT DISTINCT name FROM symbols)`), with a threshold of 50 percent.
The raw ratio over all such refs is printed as information only. The raw metric
counts test globals, matchers, DOM helpers, array methods, and package types,
which this contract defines as unresolvable (externals keep `to_key = NULL`), so
it measures a repository's test density rather than the resolver. On the
consumer's own repository the raw ceiling is about 32 percent with a perfect
resolver, while the name-matched ratio is about 65 percent. The consumer's
request document still states the raw metric and needs the same amendment on
the consumer side.

The CI replica (`tests/integration/nav-acceptance.test.ts`) asserts the symbol,
reference, resolution, and `navCapabilities` checks on a fixture. The
`indexSeq` increments across consecutive refreshes and the dirty-worktree
reindex checks are covered by the production-path `writeCache` test in
`tests/unit/lib/cache-store.test.ts` and the CLI consecutive-refresh test in
`tests/integration/cli.test.ts`.

## Appendix A: Closed kind sets

Readers treat an unknown value as `other`. The columns show what each adapter
can emit in 3.2 (the union is advertised in `navCapabilities`). TypeScript and
JavaScript are complete; Python and C-family are best effort, so an omission
there is not a contract violation.

### Symbol kinds

| kind | Meaning | TS/JS | Python | C-family |
|---|---|---|---|---|
| `function` | Function declaration, or const bound to an arrow/function expression, or default-exported function | yes | yes | yes (prototypes are declaration-only) |
| `method` | Member function, including declaration-only signatures | yes | yes | yes |
| `class` | Class declaration or class expression bound to a const | yes | yes | yes |
| `interface` | Interface declaration | yes | no | no |
| `type` | Type alias or typedef | yes | no | yes |
| `struct` | Struct or union | no | no | yes |
| `enum` | Enum declaration | yes | no | yes |
| `enum_member` | Enum member | yes | no | yes |
| `variable` | Module or file-scope variable whose value is not a function; each destructured name is one row | yes | yes | yes |
| `property` | Class or struct field, interface property signature | yes | no | yes |
| `namespace` | `namespace X {}` or `module` | yes | no | no |
| `macro` | Preprocessor macro | no | no | yes |

### Reference kinds

| kind | Position | TS/JS | Python | C-family |
|---|---|---|---|---|
| `call` | Callee of a call expression | yes | yes | yes |
| `new` | Constructor of a new expression | yes | no | yes |
| `type` | Identifier in a type position | yes | no | no |
| `extends` | Heritage clause | yes | yes | no |
| `implements` | Heritage clause | yes | no | no |
| `import` | Import specifier (see the form table in section 8) | yes | yes | no |
| `export` | Re-export or export specifier | yes | no | no |
| `member` | Property access that is not a call | yes | no | no |
| `jsx` | JSX/TSX element tag | yes | no | no |
| `decorator` | Decorator expression | yes | no | no |
