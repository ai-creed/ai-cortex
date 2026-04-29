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
| `package.json` | Add `tree-sitter-python` dep + `onlyBuiltDependencies` entry |
| `README.md` | Update Known Limitations to list `.py` |

No changes to `lang-adapter.ts`, `models.ts`, `call-graph.ts`, or `indexer.ts`. The adapter registration path already handles new languages transparently.

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

### Import site extraction (`extractImportSites`)

Handles all three Python import forms:

| Form | `rawSpecifier` | `candidate` |
|------|---------------|-------------|
| `import os.path` | `"os.path"` | `"os/path"` |
| `from foo.bar import x` | `"foo.bar"` | `"foo/bar"` |
| `from .utils import x` | `"./utils"` | resolved relative path (e.g. `"src/mypackage/utils"`) |
| `from ..base import x` | `"../base"` | resolved relative path |

Relative imports are resolved to repo-root-relative paths immediately in the adapter. Absolute imports emit the dot-to-slash-converted path; `resolveSite` in `import-graph.ts` handles the package-root strip before probing.

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

Then passed into every `resolveSite` call. Non-Python sites ignore it.

### `resolveSite` Python branch

```
candidate = "mypackage/utils"   (from import-site extraction)
packageRoots = { "", "src" }    (from discoverPythonPackageRoots)

for each root in packageRoots:
  probe1 = join(root, candidate) + ".py"          // e.g. "src/mypackage/utils.py"
    → if in allFilePaths → return probe1
  probe2 = join(root, candidate) + "/__init__.py"
    → if in allFilePaths → return probe2

return null   // stdlib / third-party — edge dropped
```

### `langOf` extension

```ts
const PY_EXTS = new Set([".py"]);
function langOf(filePath: string): "ts" | "cfamily" | "python" | "other" {
  ...
  if (PY_EXTS.has(ext)) return "python";
  return "other";
}
```

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Parse error in `.py` file | `extractFile` returns `{ functions: [], rawCalls: [], importBindings: [] }` — no throw |
| WASM grammar load failure | `initParser()` rejects; `ensureAdapters()` propagates; `.py` files silently skipped (same as TS/cfamily today) |
| `pyproject.toml` read/parse error | `discoverPythonPackageRoots` catches, returns `new Set([""])` |
| Malformed AST node | Skip that node, continue walk |
| Absolute import that matches nothing | `resolveSite` returns `null`; edge dropped |

No new error categories — the existing "skip bad input, never throw during indexing" philosophy applies uniformly.

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
- Relative import (`from .utils import x`) → correct candidate
- Absolute import (`from mypackage.foo import bar`) → `"mypackage/foo"` candidate
- `import os.path` style → `"os/path"` candidate
- `@decorator\ndef foo` → extracted correctly
- Empty file → returns empty result, no throw
- Syntax error → returns empty result, no throw

### `tests/unit/lib/import-graph.test.ts` (extend existing, new describe block)

- `discoverPythonPackageRoots`: no config → returns `""`
- `discoverPythonPackageRoots`: `pyproject.toml` with `src/` layout → returns `"src"`
- `resolveSite` Python: `"mypackage/utils"` + `allFilePaths` has `"src/mypackage/utils.py"` → resolves
- `resolveSite` Python: `"mypackage/utils"` + `allFilePaths` has `"mypackage/utils/__init__.py"` → resolves
- Absolute import with no match → returns `null`

### `tests/integration/python.test.ts` (new)

Full indexer round-trip on a small fixture at `tests/fixtures/python-basic/`:

```
tests/fixtures/python-basic/
  mypackage/__init__.py
  mypackage/utils.py      # def helper()
  mypackage/models.py     # class Model: def save(self): helper()
  main.py                 # from mypackage.models import Model; m = Model(); m.save()
```

- Index → verify function names extracted with correct qualified names
- Verify cross-file call edge: `main` → `Model.save`
- Verify `self.method()` edge: `Model.save` → `helper` (via import resolution)
- Incremental reindex after touching one file → `.py` files handled in incremental path

---

## Known Limitations (to add to README)

- **No type inference.** `obj.method()` where `obj` is not `self`/`cls` emits `rawCallee = "obj.method"`. If `obj`'s type is unknown, the edge is dropped during resolution. This is the same limitation that exists for C/C++ cross-struct calls.
- **No `__all__` awareness.** `exported: true` for all top-level names — the adapter does not consult `__all__`.
- **Dynamic imports.** `importlib.import_module(...)` and `__import__(...)` are not tracked.
