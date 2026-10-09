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
5. **`functions` is derived from `symbols` in memory.** Adapters emit one
   symbol list. The writer derives `functions` rows from it by kind. The
   consumer's invariant that every `functions` row has a `symbols` row with the
   same key and declaration range holds by construction, not by test.
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
- For kinds `function`, `method`, and `class`, the row's `file`,
  `qualified_name`, declaration range, `exported`, `is_default_export`, and
  `is_declaration_only` equal the matching `functions` row (decision 5).

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

The derivation rule for `functions` is: kinds `function`, `method`, `class`.
Existing adapter tests (`tests/unit/call-graph.test.ts`, `c-cpp.test.ts`,
`python.test.ts`) pin today's `functions` sets. If a C-family or Python node
that is in `functions` today does not fall into one of those three kinds, the
adapter assigns it one of them so the derived set is unchanged.

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
| `import` | import specifier, imported name not local alias | TS/JS, Python |
| `export` | re-export or export specifier | TS/JS |
| `member` | property access that is not a call | TS/JS |
| `jsx` | JSX/TSX element tag | TS/JS |
| `decorator` | decorator expression | TS/JS |
| `read`, `write` | plain identifier read / assignment target | not emitted (decision 8) |

### A4: `meta` additions

| key | Value | Meaning |
|---|---|---|
| `schemaVersion` | `"3.2"` | content contract |
| `navCapabilities` | JSON | `{"symbols":true,"references":true,"referencesTable":"refs","symbolKinds":[...],"referenceKinds":[...]}`. Lists the kinds this writer emits for the adapters present. A 3.2 writer always emits it. |
| `indexSeq` | integer as text | monotonically increasing per store, incremented on every successful write, full or incremental, including the empty-diff timestamp-only refresh |
| `contentFingerprint` | hex text | sha1 over sorted `(path, content_hash)` pairs of `files`, joined with newlines. Lets a consumer skip re-ingest when content is unchanged even though `indexSeq` moved. |

`fingerprint`, `indexedAt`, `dirtyAtIndex` are unchanged.

### A5: resolution rules

Shared by `refs.to_key` and `calls.to_key`. Syntactic, first hit wins:

1. **Enclosing-class member.** `this.m`, `self.m`, `cls.m` inside a class body,
   or `Class.m` written literally where `Class` is the enclosing class, resolves
   to `${file}::${Class}.${m}`. The enclosing class is the prefix of the
   enclosing symbol's `qualified_name` before the first `.`. Inherited members
   are not followed in 3.2 and fall through.
2. **Same-file bare match.** `name` equals a module-scope `qualified_name` in the
   same file.
3. **Import binding.** `name`, or the receiver of `receiver.member`, is a local
   import binding. Resolve the specifier to a target file with the existing
   logic. Named import: symbol with `qualified_name = importedName` in that
   file. Default import: `is_default_export = 1`. Namespace import: `member` in
   that file. Re-exports are followed one hop using the target file's
   `export` refs that carry a specifier.
4. **Static member on an imported or same-file class.** `Foo.bar` where `Foo`
   resolves (steps 2 or 3) to a `class`, `enum`, or `namespace` symbol resolves
   to `${thatFile}::Foo.bar`.
5. Otherwise `NULL` for refs, `::member` for calls.

Ambiguity rule: if a step yields more than one candidate (overloads aside,
which share a key), leave unresolved. This is today's `pickUnique` behavior
extended to symbols.

`calls` adopts steps 1 and 4 in 3.2. Edge `kind` on `calls` is unchanged.

### A6: writer obligations

- `symbols`, `refs`, `functions`, `calls`, `imports`, `files`, `meta` are
  written in one transaction. This is already true: `replaceAll` clears and
  refills every table inside one `db.transaction`, even for incremental
  indexes, because incrementality lives in the in-memory cache merge.
- `indexSeq` is read from the existing store before the meta table is cleared
  and written back incremented inside the same transaction. A fresh store
  starts at `1`.
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
   `indexedAt`, `dirtyAtIndex`. `index --json` prints the same object without
   `briefingPath`; `cacheStatus` is `"fresh"` or `"reindexed"`.
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
  name: string;
  kind: RefKind;
  range: Range;
  receiver?: string;                 // `a` in `a.b`; "this" | "self" | "cls" allowed
  enclosingQualifiedName?: string;   // enclosing function/method/class, undefined at module scope
  specifier?: string;                // import / export-from specifier
};

export type RefEdge = {              // resolved, stored
  file: string;
  name: string;
  kind: RefKind;
  range: Range;
  to?: string;                       // symbols key
  from?: string;                     // enclosing symbols key
};
```

`RepoCache` gains `symbols: SymbolNode[]`, `refs: RefEdge[]`, `indexSeq: number`,
`contentFingerprint: string`. `functions` stays on `RepoCache` as a derived
field so every existing reader (`blast_radius`, `suggest`, briefing) is
untouched. `SCHEMA_VERSION = "3.2"`.

`RawCallData` gains `symbols: SymbolNode[]` and `rawRefs: RawRefSite[]`. The
`functions` field is removed from adapter output; `extractCallGraphRaw` derives
it with a shared `functionsFromSymbols(symbols)` helper in `src/lib/symbols.ts`.
`AdapterCapabilities.symbolIndex` already exists and becomes meaningful: `true`
for all three adapters.

### B2: adapters

Each adapter's `extractFunctions` walk becomes `extractSymbols`, tracking an
enclosing-symbol stack so `containerQualifiedName` and `enclosingQualifiedName`
are available without re-parsing. `rangeFromNode` is reused for both ranges;
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
  arguments, `as`, `satisfies`, `typeof`, `keyof`. `import` and `export` carry
  `specifier`. `jsx` covers `jsx_opening_element` and `jsx_self_closing_element`
  name tokens. `decorator` covers the identifier or call callee of a
  `decorator` node.
- Existing `extractCallGraph` remains the single adapter entry point; it
  returns `{ symbols, rawCalls, rawRefs, importBindings }`.

**Python (`adapters/python.ts`)**, best effort: symbols `function`, `method`,
`class`, module-level `variable`; refs `call`, `import`, `extends`. `self.m`
calls already rewrite to `Class.m` in the adapter; that path now also sets
`receiver: "self"` so the resolver treats it uniformly.

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
  site: { file: string; name: string; receiver?: string; enclosingQualifiedName?: string },
  bindings: ImportBinding[],
  reexports: ReexportTable,
  includesByFile: Map<string, ImportEdge[]>,
): string | null;   // symbols key or null
export function resolveRefs(rawRefs, symbols, bindingsByFile, includesByFile): RefEdge[];
```

`resolveName` implements A5 steps 1 to 4 and the ambiguity rule. The
re-export table is built from `rawRefs` of kind `export` that carry a
`specifier`, keyed by file, so following one hop needs no new adapter output.

`resolveCallSites` keeps its signature and its `::member` fallback but delegates
steps 1 and 4 to `resolveName` before its existing logic. Existing
`call-graph.test.ts` cases continue to pass; new cases cover `this.m()` and
`Foo.bar()` static resolution. Python specifier resolution
(`resolvePythonTargetFile`) and C-family companion-file logic stay where they
are and are reached through the same `findTargetFile` helper.

`from_key` on refs is `${file}::${enclosingQualifiedName}` when the enclosing
name exists as a symbol in the same file, else `NULL`.

### B4: store and incremental merge

**`cache-store-sqlite.ts`:** DDL from A2 and A3 appended to `SCHEMA_SQL`;
`STORE_FORMAT_VERSION = 2`. `replaceAll` reads `indexSeq` from `meta` before
the `DELETE`, writes `indexSeq + 1`, `contentFingerprint`, and
`navCapabilities`, then inserts `symbols` and `refs` after `functions` and
`calls`. `container_key` is computed at insert time from
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

- `keptSymbols` and `keptRefs` are the existing rows whose `file` is not in
  the touched set and not in the affected set.
- The affected set is today's `affectedCallers` (unchanged files that import a
  touched file) plus one more hop: unchanged files that import an affected file
  which itself contains `export` refs with a specifier. This matches the
  one-hop re-export rule in A5 step 3 and is what keeps `to_key` from pointing
  at a moved symbol.
- Affected files are reparsed; `resolveRefs` and `resolveCallSites` run over
  the reparsed raw sites against the merged symbol list.
- The empty-diff path still bumps `indexSeq` and recomputes
  `contentFingerprint` (which will be unchanged).

Full reindex (`buildIndex`) is unchanged in shape; it just carries the new
fields.

### B5: CLI (`src/cli.ts`)

`parseIndexOrRehydrateArgs` returns `{ repoPath, options, help, unknown }`.
The two call sites print `INDEX_USAGE` / `REHYDRATE_USAGE` and exit per A7.
`rehydrate --json` and `index --json` build their object from
`readFreshnessMeta(dbPath)` plus the result fields already in hand. The `.json`
path string in `index` human output becomes the `.db` path from
`getCacheDbFilePath`.

### B6: documentation

- `docs/architecture/cortex-index-contract.md` becomes v3.2: section 4 covers
  `symbols.key` and the `.` separator rule including the C-family correction;
  section 7 adds the two tables and three meta keys; a new appendix lists both
  closed `kind` sets; a new section documents CLI exit codes and JSON shapes.
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
  existing call-graph fixtures byte for byte.
- **Adapter refs (TS).** One fixture exercising every emitted ref kind. Assert
  the row set is deterministic across two parses and that declaration names are
  absent.
- **Resolver.** Unit cases for each A5 step, the ambiguity rule, inheritance
  falling through to unresolved, one-hop re-export, namespace import member,
  and static enum member. Assert `calls` and `refs` agree on
  `this.open(keys)` inside a method.
- **Store round trip (`sqlite-store.test.ts`).** Write then read a cache with
  symbols and refs; assert equality. Assert `indexSeq` starts at 1, increments
  on a second write to the same path, and survives the empty-diff path. Assert
  `contentFingerprint` is unchanged when only `indexedAt` moves and changes when
  one `content_hash` changes. Assert `navCapabilities` parses and
  `referencesTable === "refs"`. Assert a `user_version = 1` store is rejected
  by `dbSchemaValid`.
- **Incremental merge.** Fixture repo with A importing B re-exporting from C.
  Move a symbol in C; assert A's `refs.to_key` is updated and no `to_key` points
  at a key absent from `symbols`.
- **CLI (`tests/integration/cli.test.ts`).** `rehydrate --help` exits 0 with
  usage on stdout and performs no index. `rehydrate --bogus` exits 2.
  `rehydrate --json` and `index --json` contain every A7 field and keep the
  existing ones. Dirty-worktree reindex changes `indexSeq` and
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
