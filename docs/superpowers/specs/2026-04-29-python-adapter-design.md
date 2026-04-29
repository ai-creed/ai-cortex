# Python Language Adapter — Design Spec

**Date:** 2026-04-29
**Status:** Approved

---

## Goal

Add Python (`.py`) support to ai-cortex's call-graph and import-graph pipelines, giving the indexer the same function extraction, call-edge resolution, and import-graph coverage for Python repos that already exists for TypeScript/JavaScript and C/C++.

---

## Architecture

### Files changed

| File | Change |
|------|--------|
| `src/lib/adapters/python.ts` | New adapter, ~300 lines |
| `src/lib/adapters/ensure.ts` | Register Python adapter alongside TS + cfamily |
| `src/lib/import-graph.ts` | Add `"python"` lang branch, `discoverPythonPackageRoots`, Python `resolveSite` |
| `src/lib/call-graph.ts` | Add `"python"` to `langOf`; add Python branch to `findTargetFile`; fix dotIndex same-file qualified lookup |
| `package.json` | Add `tree-sitter-python` dep + `onlyBuiltDependencies` entry |
| `README.md` | Update Known Limitations to list `.py` |

No changes to `lang-adapter.ts`, `models.ts`, or `indexer.ts` (see note under Data Flow).

### Parser init

Same lazy singleton pattern as `cfamily.ts`:

```ts
let pyParser: Parser | null = null;
let initPromise: Promise<void> | null = null;

async function initParser(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const { Parser, Language } = await import("web-tree-sitter");
    await Parser.init();
    const grammarPath = require.resolve("tree-sitter-python/tree-sitter-python.wasm");
    pyParser = new Parser();
    pyParser.setLanguage(await Language.load(grammarPath));
  })();
  return initPromise;
}
```

---

## Components

### Function extraction (`extractFile → functions`)

Walks `function_definition` and `decorated_definition` nodes. Tracks `className: string | null` when inside a `class_definition` body.

| Source | `qualifiedName` | `exported` |
|--------|----------------|------------|
| Module-level `def foo` | `"foo"` | `true` |
| `async def foo` | `"foo"` | `true` |
| Class-level `def foo` in `class Bar` | `"Bar.foo"` | `true` |
| `@decorator\ndef foo` (decorated_definition) | `"foo"` | `true` |

`exported` is always `true` — Python has no explicit export keyword; all top-level names are importable. `isDeclarationOnly` is never set.

### Call extraction (`extractFile → rawCalls`)

Walks `call` nodes. Two sub-cases:

1. **Plain call** `foo(args)` → `{ rawCallee: "foo", kind: "call" }`
2. **Attribute call** `obj.method(args)`:
   - If `obj` is `self` or `cls` and enclosing class is `Bar` → `{ rawCallee: "Bar.method", kind: "method" }`
   - Otherwise → `{ rawCallee: "obj.method", kind: "method" }` (resolver attempts match against known qualified names)

### Import binding extraction (`extractFile → importBindings`)

`importBindings` is the `FileExtractionResult.importBindings` field that `call-graph.ts` uses to resolve cross-file calls. The Python adapter populates it from every import statement:

| Source | `importBindings` entry |
|--------|----------------------|
| `from .utils import helper` | `{ localName: "helper", importedName: "helper", fromSpecifier: "./utils", bindingKind: "named" }` |
| `from .utils import helper as h` | `{ localName: "h", importedName: "helper", fromSpecifier: "./utils", bindingKind: "named" }` |
| `from mypackage.utils import helper` | `{ localName: "helper", importedName: "helper", fromSpecifier: "mypackage/utils", bindingKind: "named" }` |
| `import mypackage.utils as utils` | `{ localName: "utils", importedName: "utils", fromSpecifier: "mypackage/utils", bindingKind: "namespace" }` |

`fromSpecifier` uses `/` notation (dots converted to slashes for absolute imports; `./` prefix kept for relative imports). `resolveSpecifier` in `call-graph.ts` then joins it with `path.dirname(callerFile)` to produce a repo-root-relative path for `findTargetFile` lookup.

Python has no default exports, so `bindingKind: "default"` is never emitted.

### Import site extraction (`extractImportSites`)

Used by `import-graph.ts` to build the `ImportEdge[]` graph. Handles all three Python import forms:

| Form | `rawSpecifier` | `candidate` |
|------|---------------|-------------|
| `import os.path` | `"os.path"` | `"os/path"` |
| `from foo.bar import x` | `"foo.bar"` | `"foo/bar"` |
| `from .utils import x` in `pkg/models.py` | `"./utils"` | `"pkg/utils"` (repo-root-relative via path.join) |
| `from ..base import x` in `pkg/sub/models.py` | `"../base"` | `"pkg/base"` (repo-root-relative) |

Relative candidates are resolved to repo-root-relative paths immediately in the adapter. Absolute candidates emit the dot-to-slash-converted path; `resolveSite` in `import-graph.ts` handles package-root prefixing.

---

## Data Flow — Import Resolution

### Package-root discovery

New helper `discoverPythonPackageRoots(worktreePath, filePaths): Set<string>` in `import-graph.ts`:

1. Check for `pyproject.toml` in repo root → parse `[tool.setuptools] packages` or `packages.find` for `where`
2. Check for `setup.cfg` → parse `[options] package_dir`
3. Check for `setup.py` → look for `package_dir=` in file text (best-effort regex)
4. Fallback: `new Set([""])` (repo root is the package root)

Result is a `Set<string>` of root-relative prefixes (e.g. `""` for flat layout, `"src"` for src layout).

### `resolveSite` signature change

The existing `resolveSite(candidate, allFilePaths, lang)` receives a 4th optional parameter:

```ts
function resolveSite(
  candidate: string,
  allFilePaths: Set<string>,
  lang: "ts" | "cfamily" | "python" | "other",
  packageRoots?: Set<string>,   // only used when lang === "python"
): string | null
```

In `extractImports`, `packageRoots` is computed once before the per-file loop:

```ts
const hasPy = filePaths.some(f => f.endsWith(".py"));
const packageRoots = hasPy
  ? await discoverPythonPackageRoots(worktreePath, filePaths)
  : undefined;
```

### `resolveSite` Python branch

The branch tries a direct probe first (handles repo-root-relative candidates from relative imports), then applies package-root prefixes (handles absolute imports in src-layout projects). Without the direct probe first, a relative import candidate like `"src/mypackage/utils"` would be incorrectly probed as `"src/src/mypackage/utils.py"`.

```
candidate = "mypackage/utils"   (from import-site extraction; already repo-rooted for relative)

// Step 1: direct probe (covers relative import candidates already at repo-root)
probe = candidate + ".py"          → if in allFilePaths → return it
probe = candidate + "/__init__.py" → if in allFilePaths → return it

// Step 2: package-root prefix probing (covers absolute imports in src-layout)
for each non-empty root in packageRoots:
  probe = join(root, candidate) + ".py"          → if in allFilePaths → return it
  probe = join(root, candidate) + "/__init__.py" → if in allFilePaths → return it

return null   // stdlib / third-party — edge dropped
```

### `langOf` extension in `import-graph.ts`

```ts
const PY_EXTS = new Set([".py"]);
function langOf(filePath: string): "ts" | "cfamily" | "python" | "other" {
  ...
  if (PY_EXTS.has(ext)) return "python";
  return "other";
}
```

### `call-graph.ts` changes

Three targeted changes — no structural modifications:

**1. Add `"python"` to `langOf`** (same shape as in `import-graph.ts`):
```ts
function langOf(filePath: string): "ts" | "cfamily" | "python" | "other" {
  ...
  if (ext === ".py") return "python";
  return "other";
}
```

**2. Add Python branch to `findTargetFile`:**
```ts
if (callerLang === "python") {
  if (allFiles.has(normalizedSpecifier + ".py")) return normalizedSpecifier + ".py";
  if (allFiles.has(normalizedSpecifier + "/__init__.py"))
    return normalizedSpecifier + "/__init__.py";
  return null;
}
```

`normalizedSpecifier` for a relative import `fromSpecifier = "./utils"` in `mypackage/models.py` will be `resolveSpecifier("./utils", "mypackage/models.py")` = `"mypackage/utils"`. Then `"mypackage/utils.py"` probes directly into `allFiles`.

**3. Fix dotIndex same-file qualified lookup in `resolveCallSites`:**

`self.method()` emits `rawCallee = "ClassName.method"`. The dotIndex branch currently falls through to `::member` whenever no import binding matches `receiver`. This drops the edge even when `"ClassName.method"` is defined in the same file. Fix: before emitting `::member`, try the full qualified name in the same file:

```ts
// Inside the dotIndex branch, before the current fallback:
if (!resolved) {
  const sameFileQual = pickUnique(funcsByFile.get(raw.callerFile)?.get(raw.rawCallee));
  if (sameFileQual) {
    edges.push({ from: fromKey, to: `${raw.callerFile}::${sameFileQual.qualifiedName}`, kind: raw.kind });
    resolved = true;
  }
}
if (!resolved) {
  edges.push({ from: fromKey, to: `::${member}`, kind: raw.kind });
  resolved = true;
}
```

This benefits all languages (not Python-specific), and is placed immediately before the existing `::member` fallback at `call-graph.ts:123`.

### Why `indexer.ts` needs no changes

The affected-caller invalidation at `indexer.ts:151` computes:
```ts
const changedStripped = stripTsExt(changed);
if (edge.to === changedStripped || ...)
```

`stripTsExt` only strips `.ts|.tsx|.js|.jsx` — it is a no-op on `.py` paths. Python `ImportEdge.to` stores full `.py` paths (e.g. `"mypackage/utils.py"`). When `utils.py` changes, `changedStripped = "mypackage/utils.py"` and `edge.to = "mypackage/utils.py"` — the comparison matches correctly. No code change needed.

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Parse error in `.py` file | `extractFile` returns `{ functions: [], rawCalls: [], importBindings: [] }` — no throw |
| WASM grammar load failure | `initParser()` rejects; `ensureAdapters()` propagates the rejection; the entire indexing call fails (not a graceful per-language skip — same behavior as TS/cfamily WASM failure) |
| `pyproject.toml` read/parse error | `discoverPythonPackageRoots` catches, returns `new Set([""])` |
| Malformed AST node | Skip that node, continue walk |
| Absolute import that matches nothing | `resolveSite` returns `null`; edge dropped |

---

## Testing Strategy

### `tests/unit/lib/adapters/python.test.ts` (new)

Unit tests for the adapter in isolation — no filesystem, no WASM (parser mocked or small inline fixture):

- Module-level `def` → qualified name + exported flag
- `async def` → same shape
- Class-level `def` → `ClassName.method` qualified name
- `self.method()` → `ClassName.method` call emission
- `cls.method()` → same
- Plain call extraction
- Attribute call on non-self receiver → `obj.method` passthrough
- `from .utils import helper` → `importBindings` entry with `bindingKind: "named"`, `fromSpecifier: "./utils"`
- `from mypackage.foo import bar` → `importBindings` entry with `fromSpecifier: "mypackage/foo"`
- Import site: `from .utils import x` → candidate `"pkg/utils"` (repo-root-relative)
- Import site: `from mypackage.foo import bar` → candidate `"mypackage/foo"`
- Import site: `import os.path` → candidate `"os/path"`
- `@decorator\ndef foo` → extracted correctly
- Empty file → returns empty result, no throw
- Syntax error → returns empty result, no throw

### `tests/unit/lib/import-graph.test.ts` (extend existing, new describe block)

- `discoverPythonPackageRoots`: no config → returns `""`
- `discoverPythonPackageRoots`: `pyproject.toml` with `src/` layout → returns `"src"`
- `resolveSite` Python, relative candidate: `"src/mypackage/utils"` (already repo-rooted) → direct probe hits `"src/mypackage/utils.py"` (no double-prefix)
- `resolveSite` Python, absolute candidate in src-layout: `"mypackage/utils"` + packageRoots `{"src"}` → probes `"src/mypackage/utils.py"` → resolves
- `resolveSite` Python: `"mypackage/utils"` + `allFilePaths` has `"mypackage/utils/__init__.py"` → resolves
- Absolute import with no match → returns `null`

### `tests/unit/lib/call-graph.test.ts` (extend existing)

- `findTargetFile` Python: candidate `"mypackage/utils"` → resolves to `"mypackage/utils.py"` when in allFiles
- `findTargetFile` Python: candidate `"mypackage/pkg"` → resolves to `"mypackage/pkg/__init__.py"` when in allFiles
- dotIndex same-file qualified lookup: `rawCallee = "Bar.method"` with no binding + `"Bar.method"` in same file → emits same-file edge, not `::method`

### `tests/integration/python.test.ts` (new)

Full indexer round-trip on a small fixture at `tests/fixtures/python-basic/`:

```
tests/fixtures/python-basic/
  mypackage/__init__.py           (empty)
  mypackage/utils.py              # def helper(): pass
  mypackage/models.py             # from .utils import helper
                                  # class Model:
                                  #   def save(self): self.finalize()
                                  #   def finalize(self): helper()
```

Assertions:
- Function extraction: `helper`, `Model.save`, `Model.finalize` all present with correct qualified names
- `self.method()` same-file edge: `Model.save → Model.finalize` (via same-file dotIndex lookup)
- Cross-file import call: `Model.finalize → mypackage/utils.py::helper` (via importBinding + Python `findTargetFile`)
- Incremental reindex after touching `utils.py` → `models.py` included in reparse batch (verified via affected-caller logic)

Note: `m.save()` style calls (attribute calls on non-self/cls typed variables) are intentionally excluded from integration assertions — they require type inference and are documented as a known limitation.

---

## Known Limitations (to add to README)

- **No type inference.** `obj.method()` where `obj` is not `self`/`cls` emits `rawCallee = "obj.method"`. Without knowing `obj`'s type, the edge resolves at best to `::method` (unqualified fallback). Same limitation as C/C++ cross-struct calls.
- **No `__all__` awareness.** `exported: true` for all top-level names — the adapter does not consult `__all__`.
- **Dynamic imports.** `importlib.import_module(...)` and `__import__(...)` are not tracked.
- **Absolute imports from above the package root.** A top-level `main.py` importing from `src/mypackage/` via absolute path may not resolve in non-standard project layouts where the caller lives above the detected package roots.
