# C/C++ Language Adapter — Design

**Status:** Approved (brainstorm)
**Date:** 2026-04-28
**Phase:** Multi-language support, phase 1 of 3 (C/C++ first; Python and Go follow)
**Related:** `docs/shared/product_brief.md` ("C and C++ as later adapter targets")

## Goal

Add first-class C/C++ language support to the indexer so that `.c`, `.h`,
`.hpp`, `.cpp`, and related sources are parsed for symbols, call edges, and
include-based import edges. C/C++ files must surface in `suggest_files`,
`blast_radius`, and incremental reindex on the same footing as TypeScript and
JavaScript today. The work also generalizes a small set of cross-cutting
filters in the indexer so subsequent language phases (Python, Go) become
mechanical adapter additions.

## Non-Goals

- Preprocessor macro expansion. Code in `#ifdef X` is parsed unconditionally.
- C++ template instantiation tracking. Only the template name is recorded.
- `using namespace foo;` resolution.
- Typedef/alias resolution.
- Build-system integration. No `compile_commands.json`, no Make/CMake parsing,
  no system header search paths.
- Schema-bumping cache changes. `SCHEMA_VERSION = "3"` already covers
  multi-language data; one optional field is added to `FunctionNode`
  (see 1.7) — old caches without the field are read as definitions, so a
  bump is not strictly required, but a precautionary bump to `"4"` is
  acceptable if reviewers prefer.

## Approach (Approved)

Single PR that performs both the cross-cutting refactor and ships the C/C++
adapter. The refactor is small (a few regex/loc changes plus one new method on
`LangAdapter`), and the C/C++ adapter is what proves the new interface.
Splitting into two PRs was considered and rejected as ceremony without
review-time benefit.

## Architecture

### 1. Cross-Cutting Refactor

**1.1 `LangAdapter` interface gains one method.**

```ts
export type RawImportSite = {
  from: string;          // source file (repo-relative)
  rawSpecifier: string;  // verbatim string from the source (for diagnostics)
  candidate: string;     // includer-relative, normalized — not yet matched
                         // against the repo file list (resolution happens
                         // in import-graph.ts, not in the adapter)
};

export interface LangAdapter {
  extensions: string[];
  extractFile(source: string, filePath: string): FileExtractionResult;
  extractImportSites(source: string, filePath: string): RawImportSite[]; // NEW
}
```

Each adapter owns its own import-site extraction. Callers no longer need to
know the language. Canonical resolution from `RawImportSite` to `ImportEdge`
happens in `import-graph.ts` (see 2.5), where the full repo file list is
available — the adapter never sees the file list.

For the TS adapter, `rawSpecifier` is the bare module specifier
(`"./foo"`); `candidate` is the includer-relative join (already
canonicalized for module resolution today). For C/C++, `rawSpecifier` is
the literal include text; `candidate` is the includer-relative path.

**1.2 Adapter registry exposes its extension set.**

`src/lib/adapters/index.ts` adds:

```ts
export function isAdapterExt(filePath: string): boolean;
export function adapterExtensions(): string[];
```

**1.3 `import-graph.ts` becomes adapter-driven and owns canonical resolution.**

The TS-specific regex extractor in `src/lib/import-graph.ts` moves into
`src/lib/adapters/typescript.ts` as that adapter's `extractImportSites`
implementation. `import-graph.ts` becomes the single resolution stage:

```
extractImports(worktreePath, filePaths, allFilePaths):
  for each filePath:
    adapter = adapterForFile(filePath)
    sites = adapter.extractImportSites(source, filePath)
    for each site:
      to = resolveSite(site.candidate, allFilePaths, langOf(filePath))
      if to: emit { from: filePath, to }
      // unresolved sites are dropped (see 2.5)
```

`resolveSite` is language-aware (1.6): TS strips known TS extensions and
tries `/index` fallback; C/C++ matches literally with a basename-only
fallback. No language knowledge in any other consumer.

**1.4 `indexer.ts` filter generalization.**

| Location | Before | After |
|----------|--------|-------|
| line 113 | `\.(ts\|tsx\|js\|jsx)$/.test(p)` | `isAdapterExt(p)` |
| line 163 | `\.(ts\|tsx\|js\|jsx)$/.test(p)` | `isAdapterExt(p)` |
| line 19 (`stripKnownExt`) | hardcoded TS regex | derived from registry, language-aware (see 1.5) |

Local variable `changedTsFiles` renamed to `changedAdapterFiles`.

**1.5 `stripKnownExt` becomes language-aware.**

The current `stripKnownExt` collapses `.ts`/`.tsx`/`.js`/`.jsx` because they
are equivalent for module resolution. C/C++ does **not** collapse — `foo.h`
and `foo.c` are distinct files. The function takes an optional language tag
or operates only on TS-family extensions; a C/C++ specifier is matched
literally.

**1.6 `findTargetFile` becomes language-aware.**

Today `call-graph.ts:findTargetFile` strips known extensions and tries
`/index` fallback. New behavior:

- Caller in TS family: existing behavior (strip TS exts, try `/index`).
- Caller in C/C++: literal path match first; basename-only fallback for
  `#include "foo.h"` when the specifier resolves to a path that does not
  exist but exactly one repo file shares the basename.

**1.7 `FunctionNode` gains `isDeclarationOnly` (optional).**

```ts
export type FunctionNode = {
  qualifiedName: string;
  file: string;
  exported: boolean;
  isDefaultExport: boolean;
  line: number;
  isDeclarationOnly?: boolean; // NEW — true for header-only C/C++ prototypes
};
```

Default is undefined / `false`, preserving TS semantics. Required so the
call resolver can distinguish a header prototype (no body) from a
definition (callable target). See section 2.6 for resolver behavior.

**1.8 Function lookup maps become multi-valued.**

`call-graph.ts:32` (`funcsByFile`) and the targetFunc lookup in
`blast-radius.ts:26` currently assume `(file, qualifiedName)` is unique.
C++ overloads break that assumption. Same-file lookup becomes
`Map<string, FunctionNode[]>` and lookups that return more than one
non-decl entry are treated as ambiguous (see 2.6 step 1 and 2.7).

**1.9 `blast_radius` overload behavior — phase-1 aggregation.**

`blast_radius` (CLI, MCP tool at `src/mcp/server.ts:208`, library
`queryBlastRadius` at `src/lib/blast-radius.ts:17`) accepts
`{ qualifiedName, file }` as the target identity. With C++ overloads,
multiple `FunctionNode` entries can share that identity, distinguished
only by `line`.

**Phase-1 behavior:** when more than one `FunctionNode` matches
`(qualifiedName, file)`, `queryBlastRadius` aggregates — it returns the
union of callers reaching any overload, with `target.exported` set to
`true` if any matching node is exported. The result includes a new flag
`overloadCount: number` (the number of matched function nodes) so the
caller can tell that aggregation occurred. When the count is 1, behavior
is identical to today.

**Why aggregation, not selection:** without argument-type information
(deferred), there is no way to map a call site to a specific overload.
Aggregation is the only safe answer that doesn't silently drop callers.

**API surface impact:**

- `BlastRadiusResult` gains optional `overloadCount?: number` (omitted or
  `1` when target identity is unambiguous, ≥2 when overloads aggregated).
  This is the sole ambiguity signal; the existing `target` shape
  (`{ qualifiedName, file, exported }`) is unchanged — no `line` field is
  added in phase 1.
- No change to required tool inputs — backward compatible.
- A future phase may add an optional `line?: number` input to disambiguate
  and a corresponding `target.line` output, but neither is in scope here.

### 2. C/C++ Adapter

**2.1 File layout.** A single `src/lib/adapters/cfamily.ts` exports two
factories sharing helpers:

- `createCAdapter()` — extensions `[".c"]`, uses `tree-sitter-c` grammar
- `createCppAdapter()` — extensions `[".cpp", ".cc", ".cxx", ".c++", ".hpp", ".hh", ".hxx", ".h++", ".h"]`, uses `tree-sitter-cpp` grammar

`.h` is parsed with the C++ grammar. C++ is a near-superset of C and the
grammar parses pure C cleanly, so this avoids a heuristic-based grammar
selection (e.g. "is there any .cpp sibling?").

**2.2 Grammar dependencies.**

```
"tree-sitter-c": "^0.x"
"tree-sitter-cpp": "^0.x"
```

Both ship official `.wasm` grammars. Lazy-loaded via the same `initPromise`
caching pattern used by `src/lib/adapters/typescript.ts`.

**2.3 Function extraction.**

| Tree-sitter node | Extracted as |
|------------------|--------------|
| `function_definition` (top-level) | `qualifiedName = name`, `exported = true` (default), `isDeclarationOnly = false` |
| `function_definition` with `static` storage | `exported = false`, `isDeclarationOnly = false` |
| `declaration` containing `function_declarator` (header decl, no body) | `qualifiedName = name`, `exported = true`, **`isDeclarationOnly = true`** — emitted so `suggest_files` can locate header-declared APIs, but excluded from call-resolution targets (2.6) |
| C++ `function_definition` with `qualified_identifier` (e.g. `Foo::bar`) | `qualifiedName = "Foo::bar"` |
| C++ `class_specifier` body method | `qualifiedName = "ClassName::methodName"` |
| C++ `namespace_definition` enclosing | namespace prefix prepended: `Ns::Class::method`, including nested `a::b::c` |

`isDefaultExport` is always `false` for C/C++.

When both a header declaration and a same-name definition exist in the same
translation unit (header included by source), both are emitted as separate
function nodes — they live in different files.

**2.4 Raw call extraction.**

| Node | Callee form | Kind |
|------|-------------|------|
| `call_expression` w/ `identifier` | bare name | `call` |
| `call_expression` w/ `field_expression` (`obj.method`, `ptr->method`) | `obj.method` (treat `.` and `->` identically) | `method` |
| `call_expression` w/ `qualified_identifier` (`Foo::bar()`) | `Foo::bar` | `call` |
| `new_expression` (C++) | type name | `new` |

`findEnclosingFunction` walks up to the nearest `function_definition` and
returns the qualified name (including class/namespace prefix) computed from
context.

**2.5 Import edges (`#include`) — resolved at extract time, in `import-graph.ts`.**

The C/C++ adapter's `extractImportSites` only collects raw sites:

```
extractImportSites(source, filePath):
  for each preproc_include node:
    if argument is string_literal "x.h":
      candidate = path.join(dirname(filePath), unquote(literal))
      emit RawImportSite { from: filePath, rawSpecifier: literal, candidate }
    if argument is system_lib_string <x.h>:
      skip
```

Canonical resolution to `ImportEdge` runs in `import-graph.ts` (1.3), with
the full file list in scope. For each `RawImportSite`:

1. If `candidate` exists in the repo file list, emit
   `{ from, to: candidate }`.
2. Else, if exactly one repo file matches the basename, emit
   `{ from, to: thatPath }`.
3. Else, drop. Unresolved sites are not stored in `imports[]` — they
   cannot drive invalidation.

**Why resolve at extract time, not in `findTargetFile`:** the indexer's
incremental-reindex step (`indexer.ts:140-148`) walks `imports[]` and
matches `edge.to` against changed file paths. If `imports[].to` were left
as an unresolved literal candidate (e.g. `src/main/foo.h`) but the real
file lives at `include/foo.h`, edits to `include/foo.h` would never mark
`src/main.c` as an affected caller. Storing the canonical resolved path
keeps invalidation correct.

The TS adapter's `extractImportSites` returns sites whose `candidate` is
the includer-relative join with the bare specifier (no extension). The
shared resolution stage strips known TS extensions and tries `/index`,
preserving today's TS behavior.

**2.6 Cross-file call resolution (`call-graph.ts:resolveCallSites`).**

The resolver signature gains an include-edge input so step 2 has a real
data source:

```ts
export function resolveCallSites(
  rawCalls: RawCallSite[],
  allFunctions: FunctionNode[],
  bindingsByFile: Map<string, ImportBinding[]>,
  includesByFile: Map<string, ImportEdge[]>, // NEW — canonical edges from imports[]
): CallEdge[];
```

`includesByFile` is built once at the indexer/extract-graph layer from the
already-resolved `imports[]` (full set in incremental mode: kept + new),
keyed by `from`. C/C++ resolver step 2 reads it; TS resolver path ignores
it (TS uses bindings, not includes). For TS the map is still passed but
typically empty per file.

The existing TS resolver threads import bindings → target file → exported
function. C/C++ has no named bindings: `#include` exposes everything in the
header. Resolver gains C/C++-specific steps between same-file lookup and the
unresolved placeholder:

```
For a raw call in C/C++ file F:
  1. Same-file lookup. Filter out isDeclarationOnly entries. If exactly
     one non-decl candidate matches the callee name → link it. If more
     than one matches (overload), skip to step 4 (treat as ambiguous,
     unresolved).
  2. For each include edge from F → H:
       a. Look up exported, non-decl functions defined in H itself
          (header-only / inline functions, isDeclarationOnly = false).
       b. If H is a header and a companion implementation file T exists
          (same basename, different ext from .c/.cpp/.cc/.cxx), look up
          exported, non-decl functions in T. T takes precedence over H
          when both have a non-decl match — header inline definitions
          are rarer than companion-source definitions.
  3. Repo-wide unique-name fallback: if exactly one non-static, non-decl
     function anywhere in the repo (within the C/C++ language family)
     matches the callee name, link it. Skipped when more than one match
     exists (ambiguous overload). Skipped when caller is in a different
     language family (no cross-language edges).
  4. Unresolved → `::name` placeholder edge (existing).
```

The fallback in step 3 is gated to the C/C++ language family — TS files
never reach this step, preserving existing TS resolver behavior. Likewise,
step 2 is C/C++-specific because TS callers carry import bindings handled
by the existing path.

**Decl-only nodes are never resolution targets.** `isDeclarationOnly = true`
function nodes (header prototypes with no body) are excluded from steps 1,
2.a, 2.b, and 3. They still appear in `functions[]` so `suggest_files` can
surface header-declared APIs in path/symbol ranking; they simply cannot be
the destination of a `CallEdge`.

**Same-file overload disambiguation.** Step 1's "more than one match" rule
addresses the C++ overload case. It applies to step 2 lookups as well: if
T exposes two `foo` overloads, the call is treated as unresolved rather
than picking arbitrarily. Phase 1 deliberately does not attempt argument
matching.

**2.7 Phase 1 limits.**

- Macros not expanded.
- Templates: name only, no instantiation tracking.
- Overloaded functions emit one `FunctionNode` per overload (distinct by
  `line`); resolver step 2.6 treats any same-name lookup with more than
  one non-decl match as unresolved. `blast_radius` aggregates overload
  callers and signals via `overloadCount` (see 1.9).
- `using namespace X` not tracked.
- Typedefs not resolved.
- Operator overloads: extracted with the literal token (e.g. `operator+`)
  as the qualified name.

### 3. Data Flow

**3.1 Cache schema.** `RepoCache.functions[]`, `calls[]`, and `imports[]`
are already language-agnostic. `SCHEMA_VERSION` stays at `"3"`. The new
optional `FunctionNode.isDeclarationOnly` field (1.7) is additive — old
caches without the field are read with the field as `undefined`,
equivalent to a definition for resolver purposes. A precautionary bump to
`"4"` is acceptable but not required.

**3.2 First-index flow for a C/C++ file.**

```
listIndexableFiles (git ls-files)             → ["src/foo.c", "src/foo.h", ...]
diff-files                                     → all marked changed
indexer:
  changedAdapterFiles = filter(isAdapterExt)  → all .c .cpp .h
  imports = extractImports(worktree, changedAdapterFiles, allFilePaths)
    └→ adapterForFile(.c) = c-adapter
       adapter.extractImportSites(src, path)  → [RawImportSite{...}]
       resolveSite(site, allFilePaths, "c") → "src/foo.h"
       emit ImportEdge { from: "src/foo.c", to: "src/foo.h" }
  extractCallGraph(worktree, changedAdapterFiles)
    └→ extract phase per file:
         adapter.extractFile(src, path)        → fns + rawCalls
         (no bindings produced for C/C++)
       includesByFile = groupBy(imports, "from")
       resolveCallSites(rawCalls, fns, bindingsByFile, includesByFile)
         (bindingsByFile empty for C/C++ — falls into step 1 → 2 → 3 → 4;
          step 2 reads includesByFile to discover header & companion files)
```

**3.3 Incremental reindex flow — requires resolver to see merged function set.**

Touch `foo.h` → `indexer.ts:140-148` walks `imports[]`, finds every `.c`
whose import edge points at `foo.h`, adds them to `affectedCallers`,
reparses them. The path-matching half works unchanged once `isAdapterExt`
replaces the hardcoded TS regex **and** `imports[].to` carries canonical
repo paths (see 2.5).

The **resolution** half does not. Today, `extractCallGraph`
(`call-graph.ts:129`) parses each file in `filesToReparse`, then calls
`resolveCallSites` with only the functions extracted from those files.
For TS this is sufficient because each call's binding-driven resolution
points at a specific imported file, which is included in `affectedCallers`
when its symbols change.

For C/C++ the resolver needs **the full function set** — kept + new — to
match include-based and repo-wide lookups (steps 2.b and 3 in 2.6).
A changed C/C++ caller often resolves into unchanged headers and companion
source files that are not in `filesToReparse`; without those functions in
scope, calls degrade to placeholders.

**Required refactor in the indexer + call-graph layer:**

1. Decompose `extractCallGraph` into two phases:
   - `extractCallGraphRaw(worktreePath, filePaths)` — returns
     `{ rawCalls, functions, bindingsByFile }` per file, no resolution.
   - `resolveCallSites(rawCalls, allFunctions, bindingsByFile, includesByFile)` —
     called separately by the indexer with merged inputs.
2. In `indexer.ts`, after computing `keptFunctions`, `newFunctions`, and
   the merged `imports[]` array:
   - `mergedFunctions = [...keptFunctions, ...newFunctions]`
   - `includesByFile = groupBy(imports, "from")` — built from the full
     resolved imports list, so changed callers can see edges into
     unchanged headers
   - call `resolveCallSites(newRawCalls, mergedFunctions, newBindingsByFile, includesByFile)`
3. The resolver now sees the full repo symbol surface and the full
   include-edge graph, even though only `filesToReparse` were re-parsed.

This change is also a strict improvement for TS: it removes a latent edge
case where an `affectedCallers` heuristic miss would silently produce
unresolved placeholders. TS behavior remains observably the same in
existing tests because TS resolution is binding-driven and the kept call
edges from unchanged files are unaffected.

**Bindings.** `bindingsByFile` is rebuilt for `filesToReparse` only.
Resolver treats absence as "no bindings" — which mirrors today's behavior
because kept call edges from unchanged TS files are unaffected and never
re-resolved. C/C++ has no bindings, so this is a no-op for the new lang.

**Compatibility.** `extractCallGraph` keeps its outer signature for
first-index callers (returns `{ calls, functions }`), but its body
delegates to the split phases: extract → build `includesByFile` from a
fresh `extractImports` pass over the same `filePaths` → resolve. The
resolver export becomes the public seam used by the incremental path so
the indexer can inject the merged function set and the merged include
graph.

**3.4 Mixed-language repos (TS + C/C++).**

Explicit support requirement: a project with both TS and C/C++ files indexes
correctly with no cross-language false edges.

- The adapter registry routes by extension; one adapter parses TS, another
  parses C/C++.
- `findTargetFile` is language-aware (1.6): a `.ts` import does not strip
  `.h`; a `#include` does not collapse to a directory `/index` fallback.
- Repo-wide unique-name resolution (2.6.3) is gated to the same language
  family, so a TS function and a C function sharing a name do not produce
  a cross-language edge.
- `imports[]` and `calls[]` cohabit naturally — they are namespaced by file
  path and the resolution layer already keys on caller file.

**3.5 Ranker.** No change. `suggest_files` reads `imports[]`, `functions[]`,
`calls[]`, all populated identically across languages. C/C++ files surface
once symbols and includes are indexed.

## Testing

### Unit Tests

**`tests/unit/lib/adapters/cfamily.test.ts`** — both grammars covered.

C cases:
1. Plain function `int foo(void) { return 0; }` → 1 fn `foo`, exported.
2. `static int foo(void) { ... }` → exported = false.
3. Header decl `int bar(void);` in `foo.h` + same-name def in `foo.c` →
   two function nodes (one per file).
4. Call site `foo()` from inside `bar()` → raw call `bar → foo`,
   `kind: "call"`.
5. Member call `obj.fn(x)` and `ptr->fn(x)` → `kind: "method"`,
   callee `obj.fn` (both forms collapse).
6. Includes: `#include "foo.h"` → import edge; `#include <stdio.h>` → no
   edge.

C++ cases:
7. `namespace foo { void bar(){} }` → `qualifiedName = "foo::bar"`.
8. Nested namespace `namespace a::b { void c(){} }` → `"a::b::c"`.
9. Out-of-line method `void Foo::bar() {}` → `"Foo::bar"`.
10. Inline method inside class body → `"Foo::bar"`.
11. Template `template <typename T> T id(T x)` → `id`, no instantiation.
12. `new Foo()` → raw call `kind: "new"`, callee `Foo`.
13. Qualified call `Foo::bar()` → `kind: "call"`, callee `Foo::bar`.
14. Operator overload `operator+` → recorded as literal `operator+`.

### Integration Tests

**Import graph.** Two-file fixture: `foo.c` includes `foo.h`; `foo.h`
declares `int bar(void);`. Assert `imports[]` contains
`{from: "foo.c", to: "foo.h"}` and that `<system>` includes are excluded.

**Call graph.** Three-file fixture:

- `foo.h` → `int compute(int x);`
- `foo.c` → `int compute(int x) { return x + 1; }`
- `main.c` → `#include "foo.h"\nint main(void) { return compute(0); }`

Assert call edge `main.c::main → foo.c::compute, kind: "call"`. Mirror in C++
using a `Class::method` to validate qualified-name flow through the resolver.

**Indexer end-to-end.** Mixed-language fixture (TS + C + C++ side-by-side):

- Index → `functions[]` contains entries from all three languages.
- No cross-language edges in `calls[]`.
- Modify `foo.h` → all `.c` files including it land in the reparse set;
  TS files unaffected.

### Refactor Regression

- All existing TS tests pass unchanged.
- New test for `isAdapterExt` and `adapterExtensions` registry surface.
- New test for the merged-resolver behavior (3.3): construct an
  incremental index where a C caller is reparsed but its companion source
  is not, and assert the call resolves into the cached function symbol.
- New test for canonical-path import edges: a `#include "foo.h"` that
  matches via basename fallback is stored as the canonical repo path so
  that touching that path triggers `affectedCallers`.
- New test for `isDeclarationOnly`: a header-only declaration is present
  in `functions[]` (so `suggest_files` can find it) but is never the
  destination of a `CallEdge`.
- New test for same-file overload ambiguity: two `foo` overloads in one
  C++ file → call to `foo` resolves to a `::foo` placeholder, not to
  either overload arbitrarily.
- New test for blast_radius overload aggregation: query `(qualifiedName:
  "Foo::bar", file: "x.cpp")` against a fixture with two `Foo::bar`
  overloads called from distinct callers → result aggregates both
  callers and returns `overloadCount: 2`.

### Verification Commands

```
npm test            # vitest run
npm run typecheck   # tsc --noEmit
npm run bench:perf  # ensure no perf regression on TS-only repos
```

## Edge Cases

- **Header-only library** (`.h` with no companion `.c`) — symbols extracted,
  no implementation; calls into it resolve to header-defined inline fns or
  fall to placeholder.
- **Decl-only header with no def anywhere in repo** — call resolves to
  `::name` placeholder; still useful for ranker.
- **Cyclic includes** — already permitted by import-graph data model;
  no special handling.
- **Empty translation unit** (only `#include` directives) — empty
  `functions[]`, edges still emitted.
- **Conditional compilation** (`#ifdef`) — both branches parsed; documented
  overcount.
- **Syntax errors** — tree-sitter produces a partial tree; whatever parses
  is kept. `call-graph.ts:156` already catches per-file extraction errors.
- **Very large generated headers** (e.g. 50k-line protobuf output) — parser
  may be slow. Mitigation deferred to a later phase; current size cap (if
  any) inherited from existing indexer behavior.
- **Mixed TS + C/C++ repo** — exercised by indexer integration test;
  no cross-lang edges expected.

## Out of Scope (Deferred)

- Python adapter (phase 2).
- Go adapter (phase 3, requires `go.mod` parsing).
- Build-system-aware include resolution.
- Macro expansion.
- Per-language size caps for parser robustness.
