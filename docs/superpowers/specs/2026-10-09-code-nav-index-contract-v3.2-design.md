# Code-Nav Index Contract v3.2: `symbols`, `refs`, change-detection meta, member-call resolution

Status: Design, approved for planning
Date: 2026-10-09
Supersedes: nothing. Extends `docs/architecture/cortex-index-contract.md` v3.1.
Origin: consumer request from ai-14all,
`docs/superpowers/specs/2026-10-09-code-nav-index-contract-v3.2-upstream-request.md`
in the ai-14all repo. This document is the ai-cortex side: what we adopt, what
we amend, and how it lands in the code.

## Problem and goal

ai-14all builds in-app code navigation (Go to Definition, symbol search, Find
References) entirely on the ai-cortex per-worktree SQLite store. The v3.1 store
is a call graph (`functions` + `calls`), not a navigation index:

- Only callables are indexed. Interfaces, type aliases, enums, variables, and
  namespaces have no rows, so most TypeScript jumps resolve to nothing.
- `functions` carries the declaration range only. A jump lands on the
  `export async function` keyword, not on the name.
- `calls` records call, new, and method-call sites only. Type positions,
  heritage clauses, import and export specifiers, JSX tags, and member accesses
  are not recorded, so Find References cannot be built.
- `this.run()` resolves to `::run`. The receiver `this` has no import binding,
  the same-file qualified lookup misses, and the resolver gives up. On
  ai-14all, 7401 of 13637 edges are method calls and only 16 percent of all
  edges resolve.
- Freshness is keyed on `fingerprint`, which is `git rev-parse HEAD`. A
  dirty-worktree reindex rewrites the store under the same fingerprint, so a
  consumer keyed on it never picks up uncommitted edits.

Goal: an additive minor bump to schema `3.2` that makes the store a usable
navigation index for TypeScript and JavaScript, keeps every 3.1 table and
column intact, and fixes the freshness and CLI defects, in one release.

## Decisions locked during brainstorming

1. **One release.** Everything below ships together. The two-release rollout
   proposed during discussion (resolver and meta first, tables later) was
   rejected by the owner.
2. **References table is named `refs`.** `REFERENCES` is a SQLite reserved
   word. Unquoted `CREATE TABLE references` fails with a syntax error on
   SQLite 3.53. The consumer spec permits either name via
   `meta.navCapabilities.referencesTable`; we emit `"refs"`.
3. **`qualified_name` separator is `.` in every language, including C-family.**
   The C-family adapter today emits `Foo::bar` and `ns::fn`. Splitting a key on
   the first `::` is still unambiguous because file paths never contain `::`,
   but a C-family `qualified_name` cannot be split into container and member.
   We normalize to `.` for both `functions` and `symbols`. This is a C-family
   only content correction inside the minor bump and is called out in the
   contract document.
4. **TypeScript and JavaScript are complete in 3.2. Python and C-family are
   best effort.** Required kinds for TS/JS are listed below. Python and
   C-family emit what their adapters can produce cheaply; omissions are not a
   contract violation.
5. **`functions` is derived from `symbols` in memory, one row per key.**
   Adapters emit one symbol list. The writer projects `functions` rows from it
   by kind and collapses rows that share a key (overloads, `declare` plus
   implementation, same-file prototype plus definition) to a single row, so
   the 3.1 rule that `${file}::${qualifiedName}` is unique within a snapshot
   keeps holding. The consumer's invariant that every `functions` row has a
   `symbols` row with the same key and declaration range holds by
   construction, not by test. See A2.2 for the projection rule.
6. **`STORE_FORMAT_VERSION` bumps from 1 to 2, and legacy JSON caches older
   than the current schema are rejected.** Upgraded installs then fail
   `ensureValidDb` and reindex fully on first use, instead of serving a 3.1
   store until HEAD moves. The `user_version` gate covers existing `.db`
   stores; a separate exact-version gate on the legacy `.json` transcode path
   covers pre-SQLite caches, which have no `user_version` to reject (A1).
7. **`rehydrate --json` is extended additively.** It already exists and prints
   `briefingPath`, `cacheStatus`, `packageName`, `fileCount`, `docCount`. New
   fields are added; none are removed. `index --json` is new and prints the
   same object minus `briefingPath`.
8. **Optional ref kinds `read` and `write` are not emitted.** They are the only
   kinds with unbounded row growth. `decorator` is emitted for TS because it is
   cheap and bounded.

## Part A: contract changes (3.2)

### A1: versioning

- `SCHEMA_VERSION` becomes `"3.2"`. Additive tables and meta keys only.
- `STORE_FORMAT_VERSION` becomes `2` (decision 6). Readers that gate on
  `user_version` (ai-cortex itself) treat a `1` store as invalid and reindex.
- **Legacy JSON caches.** `ensureValidDb` today transcodes a `<worktreeKey>.json`
  cache into a `.db` whenever its `schemaVersion` shares the current major,
  which would turn a 3.1 JSON cache into a `user_version = 2` store with
  `schemaVersion = "3.1"`, no `symbols`, no `refs`, and no `navCapabilities`,
  and then accept it as valid. In 3.2 the JSON path requires
  `cache.schemaVersion === SCHEMA_VERSION` exactly; any other value deletes the
  JSON and returns a cache miss so the caller reindexes. This is a
  writer-internal gate on ai-cortex's own legacy format, not a change to the
  consumer rule that readers accept any minor at or above their own.
  Independently, `dbSchemaValid` and `readFromDb` also require
  `meta.schemaVersion === SCHEMA_VERSION` for stores ai-cortex itself serves,
  so a store written by a newer or older minor is reindexed rather than
  served with a capability set this binary did not produce.
- Readers written against 3.1 keep working. Readers written against 3.2
  feature-detect via `meta.navCapabilities` and fall back to `functions` when it
  is absent.

### A2: `symbols` table

One row per jumpable declaration. Superset of `functions` for the kinds that
overlap.

```sql
CREATE TABLE IF NOT EXISTS symbols (
  key                 TEXT    NOT NULL,  -- `${file}::${qualified_name}`
  file                TEXT    NOT NULL,  -- repo-relative POSIX path
  qualified_name      TEXT    NOT NULL,  -- container path joined with '.'
  name                TEXT    NOT NULL,  -- identifier text of the name node
  kind                TEXT    NOT NULL,  -- A2.1 closed set
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
CREATE INDEX IF NOT EXISTS idx_symbols_key  ON symbols(key);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);
```

Rules:

- `key` is not unique. Overloads, `declare` plus implementation pairs, and
  re-opened namespaces produce several rows with one key. Readers prefer rows
  with `is_declaration_only = 0`.
- `qualified_name` never contains `::` (decision 3).
- `name` is the name node text. Computed or string-literal member names use the
  unquoted literal. Anonymous declarations are not emitted, except
  `export default <anonymous fn/class>`, which keeps today's convention:
  `qualified_name = "default"`, `name = "default"`, name range equals the range
  of the `default` keyword.
- Scope: module scope plus members directly inside `class`, `interface`,
  `enum`, `namespace`, and object type bodies. Function-local declarations and
  parameters are not emitted.
- Every `functions` row has a `symbols` row with the same `key` and identical
  `file`, `qualified_name`, declaration range, `exported`,
  `is_default_export`, and `is_declaration_only` (decision 5). The converse
  does not hold: `symbols` may carry several rows per key, `functions`
  carries exactly one (A2.2).

#### A2.1: symbol `kind` closed set

Readers treat an unknown value as `other`.

| kind | TS/JS nodes (required) | Python (best effort) | C-family (best effort) |
|---|---|---|---|
| `function` | `function_declaration`; `lexical_declaration` whose value is `arrow_function` or `function_expression`; `export default` fn | module-scope `function_definition` | `function_definition`; prototypes with `is_declaration_only = 1` |
| `method` | `method_definition`; `method_signature` (decl-only) | `function_definition` inside `class_definition` | member functions inside `class_specifier` / `struct_specifier` |
| `class` | `class_declaration`, `abstract_class_declaration`, class expression assigned to a const | `class_definition` | `class_specifier` |
| `interface` | `interface_declaration` | not emitted | not emitted |
| `type` | `type_alias_declaration` | not emitted | `type_definition` |
| `struct` | not applicable | not applicable | `struct_specifier`, `union_specifier` |
| `enum` | `enum_declaration` | not emitted | `enum_specifier` |
| `enum_member` | enum body members | not emitted | `enumerator` |
| `variable` | module-scope `lexical_declaration` / `variable_declaration` declarators whose value is not a function; each destructured name is one row | module-level assignment targets | file-scope declarations |
| `property` | `public_field_definition`, `property_signature` | not emitted | struct and class field declarations |
| `namespace` | `internal_module` (`namespace X {}`), `module` | not applicable | `namespace_definition` |
| `macro` | not applicable | not applicable | `preproc_def`, `preproc_function_def` |

Required in 3.2 for TS/JS: `function`, `method`, `class`, `interface`, `type`,
`enum`, `enum_member`, `variable`, `property`, `namespace`.

#### A2.2: projection of `symbols` into `functions`

`functions` is `symbols` filtered to kinds `function`, `method`, `class`, then
collapsed to one row per `key`:

1. If any row for the key has `is_declaration_only = 0`, take the first such
   row in source order (the implementation; for TS overloads, the body).
2. Otherwise take the first declaration-only row in source order (a C header
   prototype, an interface method signature, an abstract method).

The projected row is the chosen `symbols` row verbatim, so the equality
invariant above holds. `calls.to_key` and `refs.to_key` point at the key, which
is shared by all rows for that declaration, so resolution is unaffected by the
collapse. `symbols` keeps every row so readers can still land on an overload
signature when they prefer to.

Existing adapter tests (`tests/unit/call-graph.test.ts`,
`tests/integration/c-cpp.test.ts`, `tests/unit/python.test.ts`) pin today's
`functions` sets. If a C-family or Python node that is in `functions` today
does not fall into one of the three kinds, the adapter assigns it one of them
so the projected set is unchanged. A same-file C prototype followed by its
definition projects to the definition only; today both rows exist with one key,
and `pickUnique` already discards the prototype, so observable resolution does
not change.

### A3: `refs` table

Identifier occurrences that name a symbol, in positions the resolver can reason
about.

```sql
CREATE TABLE IF NOT EXISTS refs (
  file      TEXT    NOT NULL,  -- file containing the occurrence
  name      TEXT    NOT NULL,  -- identifier text at the site (member name only for member access)
  kind      TEXT    NOT NULL,  -- A3.1
  line      INTEGER NOT NULL,  -- identifier token range, 1-indexed inclusive
  col       INTEGER NOT NULL,
  end_line  INTEGER NOT NULL,
  end_col   INTEGER NOT NULL,
  to_key    TEXT,              -- resolved symbols.key, NULL when unresolved
  from_key  TEXT               -- enclosing symbols.key, NULL at module scope
);
CREATE INDEX IF NOT EXISTS idx_refs_to   ON refs(to_key);
CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(name);
CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file, line);
```

Rules:

- Unresolved refs carry `to_key = NULL` and the identifier in `name`. This
  differs deliberately from `calls.to_key = '::name'`, which stays as-is for
  3.1 compatibility.
- The range is the identifier token. For `a.b.c` it is the `c` token.
- `name` is always the text of the token at the range. For import and export
  specifiers that means:

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
  names the local binding. Consumers doing bare-name fallback on a default
  import therefore match the local name, which is the only name that appears
  in the importing file.
- A declaration's own name is not a ref.
- The row set is deterministic for a given file content.

#### A3.1: ref `kind` closed set

| kind | Position | Emitted in 3.2 |
|---|---|---|
| `call` | callee of a call expression | TS/JS, Python, C-family |
| `new` | constructor of a new expression | TS/JS, Python (class call is `call`) |
| `type` | identifier in a type position: annotations, generics, `satisfies`, `as`, `typeof X`, `keyof X` | TS |
| `extends` | heritage clause | TS/JS, Python bases |
| `implements` | heritage clause | TS |
| `import` | import specifier: the imported-name token for named imports, the local-name token for default and namespace imports (A3 table) | TS/JS, Python |
| `export` | re-export or export specifier | TS/JS |
| `member` | property access that is not a call | TS/JS |
| `jsx` | JSX/TSX element tag | TS/JS |
| `decorator` | decorator expression | TS/JS |
| `read`, `write` | plain identifier read / assignment target | not emitted (decision 8) |

#### A3.2: `reexports` table (writer-internal)

The one-hop rule needs each file's named re-exports to survive incremental
indexing, where unchanged files are not reparsed. They are persisted in a
small table that is part of the storage shape but not part of the consumer
navigation contract; consumers may ignore it and `navCapabilities` does not
advertise it.

```sql
CREATE TABLE IF NOT EXISTS reexports (
  file          TEXT NOT NULL,  -- file containing the export-from statement
  exported_name TEXT NOT NULL,  -- name visible to importers (`bar` in `export { foo as bar } from`)
  source_name   TEXT NOT NULL,  -- name in the source module (`foo`)
  specifier     TEXT NOT NULL   -- raw specifier text as written (`./x`)
);
CREATE INDEX IF NOT EXISTS idx_reexports_file ON reexports(file, exported_name);
```

One row per named export-from specifier. `export * from` produces no row.
Rows are deleted and re-inserted by `file` with the rest of that file's rows.

### A4: `meta` additions

| key | Value | Meaning |
|---|---|---|
| `schemaVersion` | `"3.2"` | content contract |
| `navCapabilities` | JSON | `{"symbols":true,"references":true,"referencesTable":"refs","symbolKinds":[...],"referenceKinds":[...]}`. Lists the kinds this writer emits for the adapters present. A 3.2 writer always emits it. |
| `indexSeq` | integer as text | monotonically increasing per canonical store path, incremented on every successful write, full or incremental, including the empty-diff timestamp-only refresh. Survives the temp-db build and atomic rename in `transcodeCacheToDb` (B4). |
| `contentFingerprint` | hex text | sha1 over sorted `(path, content_hash)` pairs of `files`, joined with newlines. Lets a consumer skip re-ingest when content is unchanged even though `indexSeq` moved. |

`fingerprint`, `indexedAt`, `dirtyAtIndex` are unchanged.

### A5: resolution rules

Shared by `refs.to_key` and `calls.to_key`. Syntactic, first hit wins:

1. **Enclosing-class member.** `this.m`, `self.m`, `cls.m` inside a class body,
   or `Class.m` written literally where `Class` is the enclosing class, resolves
   to `${file}::${enclosingClass}.${m}`. `enclosingClass` is the fully
   qualified name of the innermost enclosing class as emitted by the adapter
   from its declaration stack (`N.C` for `namespace N { class C { ... } }`),
   not a prefix computed from the enclosing function name. Inherited members
   are not followed in 3.2 and fall through.
2. **Same-file bare match.** `name` equals a module-scope `qualified_name` in the
   same file.
3. **Import binding.** Two cases, because the identifier in the ref and the
   identifier in the binding differ under aliasing:
   - A ref of kind `import` carries the specifier and an internal
     `importKind` of `named`, `default`, or `namespace` (B1). It resolves
     directly, without a binding lookup: specifier to target file with the
     existing logic, then for `named` the symbol with `qualified_name = name`
     (`foo` in `import { foo as bar }`), for `default` the unique symbol with
     `is_default_export = 1` in that file, and for `namespace` nothing
     (`to_key = NULL`).
   - Any other ref whose `name` (or receiver, for `receiver.member`) equals an
     `ImportBinding.localName` (`bar`) resolves through the binding's
     `importedName` (`foo`): named import, symbol `foo` in the target file;
     default import, `is_default_export = 1`; namespace import, `member` in the
     target file.
   Re-exports are followed one hop: if the target file has a `reexports` row
   (A3.2) whose `exported_name` equals the wanted name, resolution continues
   in that row's specifier file with its `source_name`
   (`export { foo as bar } from "./x"` maps wanted `bar` to `foo` in `./x`).
   Star re-exports are not followed.
4. **Static member on an imported or same-file class.** `Foo.bar` where `Foo`
   resolves (steps 2 or 3) to a `class`, `enum`, or `namespace` symbol resolves
   to `${thatFile}::Foo.bar`.
5. Otherwise `NULL` for refs, `::member` for calls.

`calls.to_key` may name any `symbols` key, including module-level variables
(for example a call to `const execAsync = promisify(exec)`), because step 2 has
no kind restriction; the only invariant is that a non-null `to_key` exists in
`symbols`. Consumers that join `calls` to `functions` will not see those edges.

Ambiguity rule: if a step yields more than one candidate (overloads aside,
which share a key), leave unresolved. This is today's `pickUnique` behavior
extended to symbols.

`calls` adopts steps 1 and 4 in 3.2. Edge `kind` on `calls` is unchanged.

### A6: writer obligations

- `symbols`, `refs`, `reexports`, `functions`, `calls`, `imports`, `files`,
  `meta` are written in one transaction. This is already true: `replaceAll`
  clears and refills every table inside one `db.transaction`, even for
  incremental indexes, because incrementality lives in the in-memory cache
  merge. The later `indexSeq` stamp (B4) is a single-row update followed by a
  checkpoint on the not-yet-published temporary file, so readers of the
  canonical path still only ever see whole snapshots.
- `indexSeq` is carried forward from the canonical store at the destination
  path and written incremented into the new snapshot. The write path builds a
  temporary database and renames it over the canonical one, and several
  ai-cortex processes may do so for the same worktree at once (the existing
  eight-process transcode test pins that as a supported path). Reading the
  prior value, stamping the new one, and renaming therefore happen inside a
  per-store critical section held through a `BEGIN IMMEDIATE` transaction on
  a sequence sidecar database (B4 "sequence commit"). The exclusion is owned
  by the operating system's file lock, released automatically on holder exit
  or crash, so no process ever removes another process's lock. Every
  successful write publishes a strictly larger value than the write before
  it. A path with no valid prior store and no sidecar starts at `1`.
- Stale `to_key` values pointing at a deleted or moved symbol are a contract
  violation. Part B4 covers how the incremental merge honors this.
- Store stays WAL.

### A7: CLI

1. Unknown `--flag` on `index` or `rehydrate` prints the subcommand usage to
   stderr and exits `2`. `--help` and `-h` print usage to stdout and exit `0`.
   Today `parseIndexOrRehydrateArgs` keeps only known flags and ignores the
   rest, so `rehydrate --help` performs a rehydrate.
2. `rehydrate --json` prints one object with the existing fields plus
   `dbPath`, `schemaVersion`, `fingerprint`, `contentFingerprint`, `indexSeq`,
   `indexedAt`, `dirtyAtIndex`. `cacheStatus` is `"fresh"`, `"reindexed"`, or
   `"stale"`; `"stale"` is produced only with `--stale`, when the store is out
   of date and the caller asked to read it anyway, exactly as the human output
   reports today. `index --json` prints the same object without
   `briefingPath`; `index` has no `--stale` flag, so its `cacheStatus` is
   `"fresh"` or `"reindexed"`.
3. The human output of `index` prints a `.json` cache path. It becomes the
   `.db` path.
4. Exit codes: `0` on success including `fresh`, non-zero with a one-line
   stderr reason on failure. Documented in the contract.

## Part B: implementation design

### B1: models (`src/lib/models.ts`, `src/lib/lang-adapter.ts`)

New types:

```ts
export type SymbolKind =
  | "function" | "method" | "class" | "interface" | "type" | "struct"
  | "enum" | "enum_member" | "variable" | "property" | "namespace" | "macro";

export type SymbolNode = {
  qualifiedName: string;
  name: string;
  file: string;
  kind: SymbolKind;
  containerQualifiedName?: string;   // becomes container_key at write time
  exported: boolean;
  isDefaultExport: boolean;
  isDeclarationOnly: boolean;
  range: Range;                      // declaration
  nameRange: Range;                  // identifier
};

export type RefKind =
  | "call" | "new" | "type" | "extends" | "implements" | "import"
  | "export" | "member" | "jsx" | "decorator";

export type RawRefSite = {           // adapter output, never serialized
  file: string;
  name: string;                      // import: imported name; export-from: source name; else token text
  kind: RefKind;
  range: Range;
  receiver?: string;                 // `a` in `a.b`; "this" | "self" | "cls" allowed
  enclosingQualifiedName?: string;   // enclosing function/method/class, undefined at module scope
  enclosingClass?: string;           // fully qualified innermost enclosing class, e.g. "N.C"
  specifier?: string;                // import / export-from specifier
  alias?: string;                    // import: local name when it differs; export-from: exported name when it differs
  importKind?: "named" | "default" | "namespace"; // kind "import" only; drives A5 step 3 direct resolution
};

export type ReexportRow = {          // stored in `reexports` (A3.2)
  file: string;
  exportedName: string;
  sourceName: string;
  specifier: string;
};
```

`RawCallSite` gains the same `enclosingClass?: string` so `resolveCallSites`
can apply A5 step 1 without parsing `callerQualifiedName`.

```ts

export type RefEdge = {              // resolved, stored
  file: string;
  name: string;
  kind: RefKind;
  range: Range;
  to?: string;                       // symbols key
  from?: string;                     // enclosing symbols key
};
```

`RepoCache` gains `symbols: SymbolNode[]`, `refs: RefEdge[]`,
`reexports: ReexportRow[]`, `indexSeq: number`, `contentFingerprint: string`. `functions` stays on `RepoCache` as a derived
field so every existing reader (`blast_radius`, `suggest`, briefing) is
untouched. `SCHEMA_VERSION = "3.2"`.

`RawCallData` gains `symbols: SymbolNode[]`, `rawRefs: RawRefSite[]`, and
`reexports: ReexportRow[]` (derived by the adapter from its export-from refs). The
`functions` field is removed from adapter output; `extractCallGraphRaw` derives
it with a shared `functionsFromSymbols(symbols)` helper in `src/lib/symbols.ts`.
`AdapterCapabilities.symbolIndex` already exists and becomes meaningful: `true`
for all three adapters.

### B2: adapters

Each adapter's `extractFunctions` walk becomes `extractSymbols`, tracking an
enclosing-symbol stack so `containerQualifiedName`, `enclosingQualifiedName`,
and `enclosingClass` (the innermost `class` entry on that stack, fully
qualified through any namespaces) are available without re-parsing. `rangeFromNode` is reused for both ranges;
the name range comes from `childForFieldName("name")` or the `default` keyword
token.

**TypeScript (`adapters/typescript.ts`)**, required scope:

- Symbols: the A2.1 TS column. `export_statement` wrapping is handled once by a
  helper that reports `exported` and `isDefaultExport` for any declaration
  child. `is_declaration_only` is set for `method_signature`,
  `property_signature`, overload signatures (function body absent), `declare`
  declarations, and abstract methods.
- Refs: a second walk collecting the A3.1 kinds. Call and new sites reuse the
  existing call-site extraction so `calls` and `refs` agree on receiver and
  member. `type` covers `type_identifier` nodes in annotations, generic
  arguments, `as`, `satisfies`, `typeof`, `keyof`. `import` refs carry
  `specifier` and `importKind`; for named imports `name` is the imported-name
  token and `alias` the local name when aliased; for default and namespace
  imports `name` is the local-name token (A3 table). `export` refs with a
  `from` clause carry `specifier`, `name` = source name, and `alias` =
  exported name when aliased; the ref range is the source-name token, and each
  one also yields a `ReexportRow`. `export * from` yields neither. `jsx` covers `jsx_opening_element` and `jsx_self_closing_element`
  name tokens. `decorator` covers the identifier or call callee of a
  `decorator` node.
- Existing `extractCallGraph` remains the single adapter entry point; it
  returns `RawCallData`, that is
  `{ symbols, rawCalls, rawRefs, reexports, importBindings }`.

**Python (`adapters/python.ts`)**, best effort: symbols `function`, `method`,
`class`, module-level `variable`; refs `call`, `import`, `extends`. `self.m`
calls already rewrite to `Class.m` in the adapter; that path now emits
`receiver: "self"` and `enclosingClass` instead, so the resolver applies A5
step 1 uniformly across languages.

**C-family (`adapters/cfamily.ts`)**, best effort: symbols `function`, `method`,
`class`, `struct`, `enum`, `enum_member`, `type`, `macro`, file-scope
`variable`; refs `call`, `new`. The `::` joiners at lines 99, 146, 177, 202,
239, 257, 264 become `.` (decision 3). The out-of-line `Foo::bar` detection
keeps reading `::` from source text and emits `Foo.bar`.

### B3: resolver (`src/lib/call-graph.ts`, new `src/lib/symbol-resolver.ts`)

A new module owns name resolution against the symbol set:

```ts
export type ResolveSite = {
  file: string;
  name: string;
  receiver?: string;
  enclosingClass?: string;
  specifier?: string;
  importKind?: "named" | "default" | "namespace";
};
export type ReexportTable = Map<string, Map<string, { specifier: string; sourceName: string }>>; // file -> exportedName -> target

export function buildSymbolIndex(symbols: SymbolNode[]): SymbolIndex;
export function buildReexportTable(rows: ReexportRow[]): ReexportTable;
export function resolveName(
  idx: SymbolIndex,
  site: ResolveSite,
  bindings: ImportBinding[],
  reexports: ReexportTable,
  includesByFile: Map<string, ImportEdge[]>,
): string | null;   // symbols key or null
export function resolveRefs(
  rawRefs: RawRefSite[],
  symbols: SymbolNode[],
  bindingsByFile: Map<string, ImportBinding[]>,
  reexports: ReexportRow[],            // merged set on incremental, adapter output on full index
  includesByFile: Map<string, ImportEdge[]>,
): RefEdge[];
```

`resolveCallSites` gains the same `reexports: ReexportRow[]` parameter so
`calls` follow one aliased hop exactly as `refs` do; its existing four
arguments are unchanged. `RawCallSite` and `RawRefSite` map onto
`ResolveSite` field for field.

`resolveName` implements A5 steps 1 to 4 and the ambiguity rule. The
re-export table is built from `ReexportRow[]`, keyed by file and
`exportedName` and mapping to `{ specifier, sourceName }`. On a full index
those rows come straight from the adapters; on an incremental index they are
the merged set of kept rows for unchanged files plus fresh rows for reparsed
files (B4), so an importer can follow a hop through an intermediary that was
not reparsed. The `site` argument carries `enclosingClass` for step 1 and
`importKind` for step 3.

`resolveCallSites` keeps its signature and its `::member` fallback but delegates
steps 1 and 4 to `resolveName` before its existing logic. Existing
`call-graph.test.ts` cases continue to pass; new cases cover `this.m()` and
`Foo.bar()` static resolution. Python specifier resolution
(`resolvePythonTargetFile`) and C-family companion-file logic stay where they
are and are reached through the same `findTargetFile` helper.

`from_key` on refs is `${file}::${enclosingQualifiedName}` when the enclosing
name exists as a symbol in the same file, else `NULL`.

### B4: store and incremental merge

**`cache-store-sqlite.ts`:** DDL from A2, A3, and A3.2 appended to
`SCHEMA_SQL`; `STORE_FORMAT_VERSION = 2`. `replaceAll` writes
`contentFingerprint` and `navCapabilities` into `meta`, a placeholder
`indexSeq` of `"0"`, then inserts `symbols`, `refs`, and `reexports` after
`functions` and `calls`. It does not assign the sequence.

**Sequence commit.** `transcodeCacheToDb` builds the temporary database in
full, then runs a short critical section per canonical path. Mutual
exclusion comes from SQLite's own file locking on a tiny sidecar database,
`<worktreeKey>.seq.db`, never from a lock file or directory that a process
has to judge stale and remove. SQLite locks are released by the operating
system when a holder exits or dies, so there is no abandoned-lock state, no
staleness threshold, and no reclamation step for competing processes to race
on.

The sidecar holds one table, `seq(n INTEGER NOT NULL)`, with one row. It uses
the default rollback journal, not WAL, so `BEGIN IMMEDIATE` takes the
RESERVED lock and excludes every other writer across processes and threads.
The connection sets `busy_timeout = 15000`.

1. Open or create `<worktreeKey>.seq.db`; `CREATE TABLE IF NOT EXISTS seq`
   and insert the single row with `n = 0` if absent. Both statements are
   idempotent and SQLite serializes concurrent creators on the same path.
2. `BEGIN IMMEDIATE`. From here to step 7 exactly one writer per canonical
   path is inside the section; others block in the busy handler and throw a
   clear error after 15 seconds.
3. Read `seq.n`. Read `indexSeq` from the canonical `dbPath` via
   `readCanonicalIndexSeq(dbPath)`, treating a missing, unreadable, or wrong-format store
   as `0`. Let `next = max(seq.n, canonical) + 1`.
4. `UPDATE seq SET n = next` (uncommitted).
5. Open the temporary database, `UPDATE meta SET value = next WHERE key =
   'indexSeq'`, close, run `checkpointAndVerify`.
6. `fs.renameSync(tmpDb, dbPath)`.
7. `COMMIT`. On any failure before this point, `ROLLBACK` in a `finally`.

Why `max` of both sources: if a holder dies after step 6 and before step 7,
the canonical store already shows `next` while the sidecar rolls back to the
old `n`; the next writer takes `max(n, next) + 1`, so the value is never
reused. If a holder dies before step 6, nothing is published and the
sidecar rolls back, so nothing is consumed. If the canonical store is deleted
but the sidecar remains, numbering continues from the sidecar. If the sidecar
is deleted but the store remains, numbering continues from the store. In every
case each successful write publishes a value strictly greater than any value
`dbPath` showed before, and two writers starting from `n` publish `n+1` and
`n+2` in that order.

Only steps 2 to 7 are serialized; parsing and the bulk insert stay
concurrent. The `writeCache` wrapper remains the only production caller. The
sidecar and its transient `-journal` file live beside the `.db`, `.db-wal`,
and `.db-shm` files and are documented in the storage-shape section of the
contract. The sidecar is never deleted by ai-cortex's own invalidation; it
lives as long as the worktree's cache directory, so numbering continues
across store-format resets and only restarts when the whole cache directory
is removed.

**Coordinated invalidation.** `ensureValidDb`'s first branch today checks
`dbSchemaValid(dbPath)` and, on failure, deletes the store and its WAL and
SHM files, with no coordination against a writer. Two processes that both
observe a `user_version = 1` store can interleave so that A deletes it and
publishes a 3.2 store with `indexSeq = 1`, then B, acting on its stale
judgment, deletes A's store and publishes another with `indexSeq = 1`. In
3.2 the discard runs inside the same exclusion as the sequence commit:

The three top-level branches of `ensureValidDb` keep today's order and
meaning: (1) a `.db` exists, (2) no `.db` but a legacy `.json` exists,
(3) nothing on disk. Only branch 1's discard changes:

1. **`.db` present and valid** (unlocked `dbSchemaValid` fast path): return
   `dbPath` immediately with no lock taken, deleting any leftover `.json` as
   today.
2. **`.db` present and invalid:** open the sequence sidecar and
   `BEGIN IMMEDIATE`, blocking behind any in-flight sequence commit. Under
   the lock, re-check:
   - now valid: another process upgraded it; `COMMIT` and return `dbPath`
     without deleting anything.
   - now absent: another process already discarded it; `COMMIT` and
     continue to branch 2 below exactly as if no `.db` had been found.
   - still invalid: delete `dbPath`, `-wal`, and `-shm`, `COMMIT`, print
     the existing "cache schema updated, reindexing" notice, and return
     `null`. The sequence sidecar is left in place.
3. **No `.db`, legacy `.json` present:** unchanged apart from the exact
   version gate (A1). A `3.2` JSON transcodes through `transcodeCacheToDb`,
   whose sequence commit provides the only coordination this branch needs;
   any other version deletes the JSON and returns `null`. No lock is taken
   around the JSON read: the file is read-only input, two processes
   transcoding it concurrently are just two sequence commits, and deleting
   it twice is harmless.
4. **Nothing on disk:** return `null`, as today.

An absent `.db` therefore never enters the locked path; it goes straight to
branch 3, so a current-version JSON cache still migrates. Because a writer's
rename (B4 step 6) and the invalidator's delete both happen only while
holding the sidecar transaction, no process can delete a store that was
published after its own validity check. The reindex that follows a `null`
return is an ordinary `writeCache` with its own sequence commit, so two
processes that both reindex publish distinct, increasing values.

**`cache-store.ts` upgrade gate.** `ensureValidDb` branch 3 (legacy JSON)
compares `cache.schemaVersion` to `SCHEMA_VERSION` exactly before
transcoding and deletes the JSON on mismatch (A1). `dbSchemaValid` and
`readFromDb` compare `meta.schemaVersion` to `SCHEMA_VERSION` exactly in
addition to the `user_version` check. Both changes are single comparisons at
existing gate sites. The sidecar open, `BEGIN IMMEDIATE`, and `COMMIT` are
factored into one helper, `withSequenceLock(dbPath, fn)`, used by both
`transcodeCacheToDb` and `ensureValidDb` so the two paths cannot drift onto
different lock files. `container_key` is computed at insert time from
`containerQualifiedName`. `assembleCache` reads both tables back. The lean
`readFreshnessMeta` path gains `indexSeq` and `contentFingerprint` so the CLI
JSON output does not need a full materialize.

`contentFingerprint` is computed in one place, `computeContentFingerprint(files)`
in `src/lib/cache-store.ts`, and called from both `buildIndex` and
`buildIncrementalIndex`.

`navCapabilities.symbolKinds` and `referenceKinds` are the union of kinds the
registered adapters declare, exposed as two static arrays per adapter, not the
kinds observed in this repo. A consumer can then rely on them without scanning.

**`indexer.ts` incremental path.** Mirrors today's `functions` and `calls`
handling:

- `keptSymbols`, `keptRefs`, and `keptReexports` are the existing rows whose
  `file` is not in the touched set and not in the affected set.
- The affected set is today's `affectedCallers` (unchanged files that import a
  touched file) plus one more hop: unchanged files that import an affected file
  which has at least one `reexports` row. This matches the one-hop re-export
  rule in A5 step 3 and is what keeps `to_key` from pointing at a moved
  symbol.
- Affected files are reparsed; `resolveRefs` and `resolveCallSites` run over
  the reparsed raw sites against the merged symbol list and the merged
  re-export table (`keptReexports` plus the reparsed files' rows). An edit
  that touches only an importer therefore still follows an untouched
  intermediary's re-export, because that intermediary's mapping is read back
  from the store rather than from a parse that did not happen.
- The empty-diff path still bumps `indexSeq` and recomputes
  `contentFingerprint` (which will be unchanged).

Full reindex (`buildIndex`) is unchanged in shape; it just carries the new
fields.

### B5: CLI (`src/cli.ts`)

`parseIndexOrRehydrateArgs` returns `{ repoPath, options, help, unknown }`.
The two call sites print `INDEX_USAGE` / `REHYDRATE_USAGE` and exit per A7.
`rehydrate --json` and `index --json` build their object from
`readFreshnessMeta(dbPath)` plus the result fields already in hand.
`cacheStatus` is passed through from `rehydrateRepo` unchanged, so the
`"stale"` value produced by `--stale` reaches the JSON as it reaches the human
output today. The `.json`
path string in `index` human output becomes the `.db` path from
`getCacheDbFilePath`.

### B6: documentation

- `docs/architecture/cortex-index-contract.md` becomes v3.2: section 4 covers
  `symbols.key` and the `.` separator rule including the C-family correction;
  section 7 adds the two consumer tables, the writer-internal `reexports`
  table, the three meta keys, the `<worktreeKey>.seq.db` sequence sidecar
  with its transient `-journal`, and the exact-version gate on legacy JSON
  caches; a new
  appendix lists both closed `kind` sets and the import-form table from A3; a
  new section documents CLI exit codes and JSON shapes.
- `README.md` and the relevant `docs/reference/` page mention the navigation
  index and the `--json` flags.
- `CHANGELOG.md` entry in the narrative style, committed before
  `scripts/release.sh`.

## Section C: testing

Test-first per task. Fixtures live under `tests/fixtures/`.

- **Adapter symbols (per language).** A fixture file per language covering every
  kind in its A2.1 column. Assert kind, name, qualified name, container,
  exported flags, declaration range, and name range. Assert
  `name_line = line` and `name_col > col` for a typical `export interface`.
  Assert `functionsFromSymbols` reproduces today's `functions` set for the
  existing call-graph fixtures byte for byte, and that for a TS fixture with
  two overload signatures plus an implementation, `symbols` holds three rows
  with one key while `functions` holds exactly one row, the implementation.
  Assert the same one-row outcome for a same-file C prototype plus definition.
- **Adapter refs (TS).** One fixture exercising every emitted ref kind. Assert
  the row set is deterministic across two parses and that declaration names are
  absent. Assert the exact row shape for every form in the A3 import table:
  named, aliased named, default, namespace, export-from, aliased export-from,
  local export, and that `export * from` and side-effect imports produce no
  row. Assert each export-from yields one `ReexportRow` with the expected
  exported and source names.
- **Resolver.** Unit cases for each A5 step, the ambiguity rule, inheritance
  falling through to unresolved, namespace import member, and static enum
  member. Aliasing cases: `import { foo as bar }` followed by `bar()` resolves
  the `import` ref and the `call` ref to `foo`'s key; `export { foo as bar }
  from "./x"` in an intermediary resolves an importer's `bar` to `foo` in
  `./x`. Enclosing-class cases: `this.open(keys)` inside a module-scope class
  method, and inside `namespace N { class C { run() { this.open() } } }`,
  which must resolve to `N.C.open`, not `N.open`. Assert `calls` and `refs`
  agree on every `this.` case.
- **Store round trip (`sqlite-store.test.ts`).** Write then read a cache with
  symbols and refs; assert equality. Assert `indexSeq` through the production
  path only: two consecutive `writeCache` calls for the same worktree (each
  building a temp database and renaming it over the canonical path) yield
  `1` then `2`, a third call after an empty-diff incremental refresh yields
  `3`, and a `writeCache` over a `user_version = 1` store with no sidecar present (the pre-3.2 layout) starts at `1`.
  Legacy JSON regression, beside the existing legacy-JSON transcode cases in
  `tests/unit/lib/cache-store.test.ts`: a
  `<worktreeKey>.json` cache with `schemaVersion: "3.1"` and the current major
  makes `ensureValidDb` return `null` and delete the JSON, and no `.db` is
  created from it; a JSON cache with `schemaVersion: "3.2"` still transcodes.
  A `.db` with `user_version = 2` but `meta.schemaVersion = "3.1"` is also
  rejected by `dbSchemaValid`.
  Extend the existing eight-process concurrent transcode test: after all
  eight processes finish, `indexSeq` equals `8` and `seq.n` equals `8`,
  proving each write took a distinct value, and no `-journal` file remains.
  Add three crash and contention cases, each with real child processes:
  (1) a child takes `BEGIN IMMEDIATE` on the sidecar and is `SIGKILL`ed while
  holding it; a following `writeCache` succeeds without any wait beyond lock
  release and publishes `n+1`; (2) a child is killed after the rename and
  before `COMMIT` (simulated by a test hook that exits between steps 6 and
  7); the sidecar rolls back, the store shows `n+1`, and the next
  `writeCache` publishes `n+2`, never `n+1` again; (3) two children race to
  write while a third holds the sidecar lock for 200 ms; both wait, both
  succeed, and the published values are distinct and increasing. Also assert
  that a `writeCache` with the sidecar deleted continues from the store's
  value, and with the store deleted continues from the sidecar's.
  Concurrent-upgrade interleaving, with a `user_version = 1` store on disk
  and two child processes: child B runs `ensureValidDb` with a test hook that
  pauses it after its unlocked validity check and before it takes the
  sidecar lock; child A runs `ensureValidDb` to completion, then `writeCache`,
  publishing a 3.2 store with `indexSeq = 1`; B is released. Assert B
  returns A's `dbPath` without deleting it, A's store is byte-identical
  before and after B's run, no second store with `indexSeq = 1` is ever
  published, and if B subsequently writes it publishes `2`. Repeat with B
  paused while A holds the sidecar lock mid-commit, asserting B blocks and
  then observes A's store as valid. Third variant: B is released after A has
  discarded the invalid store but before A has written; B's locked recheck
  finds the store absent, B falls through to the JSON branch and returns
  `null` without deleting anything, and when A later publishes `indexSeq =
  1` B's own write publishes `2`. Fourth variant, absent store plus JSON: no
  `.db` on disk and a `schemaVersion: "3.2"` JSON cache present; assert
  `ensureValidDb` takes no sidecar lock before the transcode, the JSON is
  transcoded into a valid `.db` with `indexSeq = 1`, and the JSON is removed.
  Assert
  `contentFingerprint` is unchanged when only `indexedAt` moves and changes when
  one `content_hash` changes. Assert `navCapabilities` parses and
  `referencesTable === "refs"`. Assert a `user_version = 1` store is rejected
  by `dbSchemaValid`.
- **Incremental merge.** Fixture repo with A importing B re-exporting from C,
  including one aliased re-export. Three cases: (1) move a symbol in C and
  assert A's `refs.to_key` is updated; (2) edit only A, adding a new reference
  to the re-exported name, and assert the new ref resolves to C's key even
  though B was not reparsed; (3) remove the re-export from B and assert A's
  ref becomes `NULL`. In every case assert no `to_key` points at a key absent
  from `symbols`, and that `reexports` rows for untouched files are unchanged.
- **CLI (`tests/integration/cli.test.ts`).** All cases spawn the built
  `dist/src/cli.js` binary. Flag handling is asserted for both commands
  through a shared table of four invocations per command, `index` and
  `rehydrate`, each on a fixture repo with no prior cache:
  - `<cmd> --help` and `<cmd> -h`: exit code `0`, stdout contains the
    subcommand usage block, stderr is empty, and no `.db` is created
    (proving no index ran).
  - `<cmd> --bogus`: exit code `2`, stderr contains the subcommand usage
    block and names the unknown flag, stdout is empty, and no `.db` is
    created.
  - `<cmd> --bogus --json`: identical outcome, proving an unknown flag wins
    over a known one and no partial JSON is printed.
  `rehydrate --json` and `index --json` contain every A7 field and keep the
  existing ones; `index --json` has no `briefingPath`. `index` human output
  prints the `.db` cache path, not `.json`. `rehydrate --stale --json` against an out-of-date store
  reports `cacheStatus: "stale"` and does not change `indexSeq`. Two
  consecutive `index --refresh --json` invocations of the built CLI binary
  on an unchanged fixture repo report `indexSeq` values `n` and `n+1`, the
  same `fingerprint` and `contentFingerprint`, and `cacheStatus:
  "reindexed"` both times; this is the CLI-layer counterpart of the
  `writeCache` sequence tests and is what the consumer's section 11 check
  exercises. A dirty-worktree `rehydrate --json` (after editing a tracked
  file without committing) reports a changed `indexSeq` and
  `contentFingerprint` while `fingerprint` stays.
- **Consumer acceptance replica (CI).** A TS fixture mirroring the ai-14all
  acceptance list (interface `WorktreeStatus`, class `CortexIndexService` with
  `findDefinitions` calling `this.open`). Run through `indexRepo` and assert
  the section 11 symbol, reference, resolution, and `navCapabilities` checks
  from the consumer spec. The "indexSeq increments across consecutive
  refreshes" and "dirty reindex" checks are covered instead by the
  production-path `writeCache` test in `tests/unit/lib/cache-store.test.ts`
  and the CLI consecutive-refresh test in `tests/integration/cli.test.ts`, not
  by `tests/integration/nav-acceptance.test.ts`. The resolved-ref ratio: rows with `to_key IS NOT NULL` are at least 50 percent of rows with
  `kind IN ('call','new','type','import')` on the fixture.
- **Consumer acceptance on the real repository (release gate).** A script,
  `scripts/acceptance-v3.2.sh <path-to-ai-14all-worktree>`, runs
  `ai-cortex index --refresh` on that worktree and then executes the section
  11 queries against the resulting store with hard pass/fail thresholds:
  `symbols` has at least one `interface` row and the `WorktreeStatus` row has
  `name_line = line` and `name_col > col`; the `CortexIndexService.findDefinitions`
  row has the specified kind, name, container key, and qualified name; every
  `functions` row has a `symbols` row with the same key and declaration range;
  `refs` has at least one `type` row; resolved refs are **at least 50 percent**
  of `call`, `new`, `type`, and `import` refs whose `name` is defined as a
  symbol in the indexed repo (`name IN (SELECT DISTINCT name FROM symbols)`),
  with the raw ratio over all such refs reported as information only. The raw
  metric counts test globals, matchers, DOM helpers, array methods, and package
  types that the contract defines as unresolvable (externals keep
  `to_key = NULL`), so it measures a repo's test density rather than the
  resolver; on the consumer's own repository the raw ceiling is about 32
  percent with a perfect resolver while the name-matched ratio is about 65
  percent. The consumer's request document in ai-14all still states the raw
  metric and needs the same amendment on their side; `this.open(keys)` inside
  `findDefinitions` resolves to `CortexIndexService.open` in both `refs` and
  `calls`; `navCapabilities` parses and lists the emitted kinds; two
  consecutive `index --refresh` runs report increasing `indexSeq`; a
  dirty-worktree reindex changes `indexSeq` and `contentFingerprint` while
  `fingerprint` stays; and a 3.1 fixture store still ingests through the
  consumer's fallback path. The script exits non-zero on any failed check and
  prints the measured ratio and the `calls` resolution rate. It cannot run in
  CI because it needs the ai-14all checkout, so it is a mandatory step in the
  release checklist below: the tag is not cut while it fails. The measured
  numbers are recorded in the changelog entry.

Verification before claiming completion: `CI=true pnpm test`, `pnpm typecheck`,
`pnpm lint`, `pnpm build`, and `scripts/acceptance-v3.2.sh` against the local
ai-14all worktree exiting `0`. The last item is the release gate for the
consumer's section 11 list; a failing threshold, including the 50 percent
resolved-ref ratio, blocks the release until the resolver or adapters are
fixed, not until the number is merely written down.

## Files in scope

- `src/lib/models.ts`, `src/lib/lang-adapter.ts`
- `src/lib/symbols.ts` (new), `src/lib/symbol-resolver.ts` (new)
- `src/lib/adapters/typescript.ts`, `python.ts`, `cfamily.ts`
- `src/lib/call-graph.ts`, `src/lib/indexer.ts`
- `src/lib/cache-store-sqlite.ts`, `src/lib/cache-store.ts`
- `src/cli.ts`
- `scripts/acceptance-v3.2.sh` (new, release gate against the ai-14all worktree)
- `docs/architecture/cortex-index-contract.md`, `README.md`, `docs/reference/*`,
  `CHANGELOG.md`
- tests listed in Section C

This is more than three files, so the implementation plan breaks it into
tasks of at most three production files each.

## Risks and mitigations

- **Sequence section contention.** The critical section is a meta read, two
  one-row updates, a checkpoint, and a rename, so holders release in
  milliseconds. Exclusion is SQLite's file lock on the sequence sidecar,
  released by the kernel on process exit, so a crashed holder cannot wedge
  later writers and no process ever reclaims another's lock. The 15-second
  busy timeout turns a pathological stall into a clear error instead of a
  hang. The one known limitation is network filesystems with broken POSIX
  advisory locking, where SQLite itself documents that locking is unreliable;
  `~/.cache/ai-cortex` is expected to be local.
- **Index time and store size.** Refs add a second tree walk per TS file and
  roughly 50 rows per file. Measure full-index duration and `.db` size on
  ai-cortex (631 files) and ai-14all (1347 files) before and after; a
  regression above 30 percent in index time blocks the release until the walk
  is merged with the existing one.
- **C-family separator change** alters `functions.qualified_name` for C-family
  repos. No known consumer reads C-family keys; the contract calls it out.
- **Incremental sweep naming.** In an incremental build, a `calls` row whose
  target key was removed is swept to the unresolved form `::<qualified name of
  the stale target>`, while a full build writes `::<raw callee>` or
  `::<member>`, so the unresolved name can differ between an incremental and a
  full build for the same source.
- **C-family edges outside the affected set.** C-family calls resolved through
  companion source files or the repo-wide unique-name fallback are outside the
  import-based affected set, so when such a target moves an incremental build
  sweeps the caller's edge to unresolved instead of re-pointing it. A full
  reindex repairs it.
- **Incremental staleness** through re-export chains longer than one hop is
  still possible. It matches the documented one-hop rule; a full `index
  --refresh` repairs it.
- **Adapter `functions` output removal** touches every adapter test. The
  derivation helper is pinned against existing fixtures first, so any drift
  shows up before adapters change.
- **`user_version` bump** forces one full reindex per worktree on upgrade. The
  cost is the same as a fresh clone and happens once.

## Out of scope

- Type inference or a language server. Resolution stays syntactic plus
  import-binding based.
- A rename-stable symbol id. `functions.id` stays reserved.
- Removing or reshaping `functions` and `calls`.
- Cross-worktree or cross-repo resolution.
- Inherited member resolution (`this.m` where `m` lives on a base class).
  Candidate for 3.3 as a one-hop `extends` walk.
- `read` and `write` ref kinds.
