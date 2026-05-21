# Language Support

Use this page to understand what ai-cortex can structurally analyze today.

ai-cortex can index any git repository at the file level, but parser-backed structural analysis is available only for specific languages.

## Summary

| Language | Extensions | Structural support |
|---|---|---|
| TypeScript / JavaScript | `.ts`, `.tsx`, `.js`, `.jsx` | imports, functions, class methods, call graph |
| Python | `.py` | imports, functions, class methods, partial call graph |
| C | `.c` | functions, call graph |
| C++ | `.cpp`, `.cc`, `.cxx`, `.c++`, `.hpp`, `.hh`, `.hxx`, `.h++`, `.h` | functions, call graph |
| Other languages | any indexed file | file discovery only |

File discovery can still return unsupported-language files by path and content signals. Call graph and blast-radius analysis depend on parser-backed language adapters.

## TypeScript And JavaScript

Supported extensions:

```text
.ts
.tsx
.js
.jsx
```

Extracted structure:

- imports
- named functions
- arrow functions assigned to names
- class methods
- default and named exports
- call edges where statically resolvable

Known limits:

- dynamic imports are limited
- computed property calls can remain unresolved
- higher-order calls are not fully resolved

## Python

Supported extension:

```text
.py
```

Extracted structure:

- imports
- module-level functions
- class methods
- self/cls method calls
- some module-qualified calls

Known limits:

- no general type inference for arbitrary `obj.method()` calls
- no `__all__` awareness
- dynamic imports are not tracked
- `from pkg import submodule; submodule.func()` can miss edges where direct module imports would resolve better

## C And C++

C extension:

```text
.c
```

C++ extensions:

```text
.cpp
.cc
.cxx
.c++
.hpp
.hh
.hxx
.h++
.h
```

Extracted structure:

- function definitions
- declaration-only functions where detected
- call edges where statically resolvable
- header/source relationships through shared file analysis

Known limits:

- macro-heavy code can hide structure
- template-heavy C++ can reduce call graph confidence
- function pointer calls are not fully resolved
- generated headers may add noise if tracked

## Unsupported Languages

Unsupported languages still participate in:

- file tree indexing
- doc discovery
- path-based ranking
- content scan in deep suggestions

They do not produce parser-backed functions, imports, or call graph edges.

Examples:

- Go indexes as files, but no Go call graph is produced.
- Rust indexes as files, but no Rust call graph is produced.

## Blast Radius Confidence

`blast_radius` depends on call graph quality.

Confidence can be:

| Value | Meaning |
|---|---|
| `full` | No unresolved call edges affected the result |
| `partial` | Some dynamic or unresolved call sites were present |

Treat `partial` as a useful impact hint, not a complete proof.

## Adapter Model

Adapters implement the `LanguageAdapter` interface:

```ts
type LanguageAdapter = {
	extensions: string[];
	capabilities: {
		importExtraction: boolean;
		callGraph: boolean;
		symbolIndex: boolean;
	};
	extractImports(...): Promise<RawImportSite[]>;
	extractCallGraph?(...): Promise<RawCallData>;
};
```

Built-in adapters are registered on first use.

## Related Docs

- [CLI reference](./cli.md): `suggest`, `suggest-deep`, `suggest-semantic`, and `blast_radius`.
- [MCP tools](./mcp-tools.md): `suggest_files` and `blast_radius`.
- [Library API](./library-api.md): exported adapter and call graph types.
- [Limitations](./limitations.md): broader system limitations.
