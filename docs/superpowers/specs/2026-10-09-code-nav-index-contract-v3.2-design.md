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
6. **`STORE_FORMAT_VERSION` bumps from 1 to 2.** Upgraded installs then fail
   `ensureValidDb` and reindex fully on first use, instead of serving a 3.1
   store until HEAD moves.
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
| `property` | `public_field_definition`, `property_signature` | not emitted | field declarations |
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
  per-store critical section (B4 "sequence commit"), so every successful write
  observes a strictly larger value than the write before it. A path with no
  valid prior store starts at `1`.
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
  returns `{ symbols, rawCalls, rawRefs, importBindings }`.

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
export function buildSymbolIndex(symbols: SymbolNode[]): SymbolIndex;
export function resolveName(
  idx: SymbolIndex,
  site: { file: string; name: string; receiver?: string; enclosingClass?: string; specifier?: string },
  bindings: ImportBinding[],
  reexports: ReexportTable,
  includesByFile: Map<string, ImportEdge[]>,
): string | null;   // symbols key or null
export function resolveRefs(rawRefs, symbols, bindingsByFile, includesByFile): RefEdge[];
```

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
full, then runs a short critical section per canonical path:

1. Acquire `<dbPath>.lock` by `fs.mkdirSync` (atomic create on POSIX and
   Windows). On `EEXIST`, if the lock directory's mtime is older than 30
   seconds it is treated as abandoned, removed, and retried; otherwise wait
   10 to 50 ms with jitter and retry, for up to 15 seconds, then throw.
2. Read `indexSeq` from the canonical `dbPath` via `readFreshnessMeta`,
   treating a missing, unreadable, or wrong-format store as `0`.
3. Open the temporary database, `UPDATE meta SET value = ? WHERE key =
   'indexSeq'` with the prior value plus one, close, run
   `checkpointAndVerify`.
4. `fs.renameSync(tmpDb, dbPath)`.
5. Remove the lock directory in a `finally`.

Only steps 2 to 4 are serialized; parsing and the bulk insert stay
concurrent. Because read, stamp, and rename happen under one lock, two
writers that start from `n` produce `n+1` and `n+2`, and the store at
`dbPath` never shows a sequence smaller than one it showed before. The
`writeCache` wrapper remains the only production caller. The lock directory
is transient and lives beside the `.db`, `.db-wal`, and `.db-shm` files; it
is documented in the storage-shape section of the contract. `container_key` is computed at insert time from
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
  table, the three meta keys, and the transient `.lock` directory; a new
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
  `3`, and a `writeCache` over a `user_version = 1` store restarts at `1`.
  Extend the existing eight-process concurrent transcode test: after all
  eight processes finish, `indexSeq` equals `8`, proving each write took a
  distinct value, and no `.lock` directory remains. Add a case where a stale
  lock directory older than 30 seconds is present and the write still
  succeeds, and a case where a fresh lock held by the test makes the write
  wait and then succeed once the lock is released. Assert
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
- **CLI (`tests/integration/cli.test.ts`).** `rehydrate --help` exits 0 with
  usage on stdout and performs no index. `rehydrate --bogus` exits 2.
  `rehydrate --json` and `index --json` contain every A7 field and keep the
  existing ones. `rehydrate --stale --json` against an out-of-date store
  reports `cacheStatus: "stale"` and does not change `indexSeq`. Dirty-worktree reindex changes `indexSeq` and
  `contentFingerprint` while `fingerprint` stays.
- **Consumer acceptance replica.** A TS fixture mirroring the ai-14all
  acceptance list (interface `WorktreeStatus`, class `CortexIndexService` with
  `findDefinitions` calling `this.open`). Run through `indexRepo` and assert
  the section 11 checks from the consumer spec. Before tagging, run the real
  acceptance queries against the ai-14all worktree by hand and record the
  resolution rate in the changelog.

Verification before claiming completion: `CI=true pnpm test`, `pnpm typecheck`,
`pnpm lint`, `pnpm build`.

## Files in scope

- `src/lib/models.ts`, `src/lib/lang-adapter.ts`
- `src/lib/symbols.ts` (new), `src/lib/symbol-resolver.ts` (new)
- `src/lib/adapters/typescript.ts`, `python.ts`, `cfamily.ts`
- `src/lib/call-graph.ts`, `src/lib/indexer.ts`
- `src/lib/cache-store-sqlite.ts`, `src/lib/cache-store.ts`
- `src/cli.ts`
- `docs/architecture/cortex-index-contract.md`, `README.md`, `docs/reference/*`,
  `CHANGELOG.md`
- tests listed in Section C

This is more than three files, so the implementation plan breaks it into
tasks of at most three production files each.

## Risks and mitigations

- **Sequence lock contention or abandonment.** The critical section is a
  meta read, one-row update, checkpoint, and rename, so holders release in
  milliseconds; the 30-second stale threshold only matters if a process dies
  mid-section, and the 15-second wait bound turns a wedged lock into a clear
  error instead of a hang. A crash between the stale check and `rmdir` by two
  breakers at once is tolerated because `mkdirSync` still admits only one.
- **Index time and store size.** Refs add a second tree walk per TS file and
  roughly 50 rows per file. Measure full-index duration and `.db` size on
  ai-cortex (631 files) and ai-14all (1347 files) before and after; a
  regression above 30 percent in index time blocks the release until the walk
  is merged with the existing one.
- **C-family separator change** alters `functions.qualified_name` for C-family
  repos. No known consumer reads C-family keys; the contract calls it out.
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
