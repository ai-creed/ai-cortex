// tests/unit/lib/adapters/symbol-fixtures.test.ts
// Spec Section C "Adapter symbols (per language)": one fixture per language
// covering every kind in its A2.1 column, asserted as complete rows, plus the
// byte-for-byte parity of functionsFromSymbols against the pre-3.2 functions.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
	createCAdapter,
	createCppAdapter,
} from "../../../../src/lib/adapters/cfamily.js";
import { ensureAdapters } from "../../../../src/lib/adapters/ensure.js";
import { getAdapterForFile } from "../../../../src/lib/adapters/index.js";
import { createPythonAdapter } from "../../../../src/lib/adapters/python.js";
import { createTypescriptAdapter } from "../../../../src/lib/adapters/typescript.js";
import type { LanguageAdapter } from "../../../../src/lib/lang-adapter.js";
import type {
	FunctionNode,
	SymbolKind,
	SymbolNode,
} from "../../../../src/lib/models.js";
import {
	C_SYMBOL_KINDS,
	PY_SYMBOL_KINDS,
	TS_SYMBOL_KINDS,
	functionsFromSymbols,
	symbolKey,
} from "../../../../src/lib/symbols.js";

const FIXTURES = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../fixtures",
);

async function symbolsOf(
	adapter: LanguageAdapter,
	file: string,
): Promise<SymbolNode[]> {
	const r = await adapter.extractCallGraph!(FIXTURES, file);
	return r.symbols;
}

/** Full rows per kind, and every listed kind present at least once. */
function expectEveryKind(
	actual: SymbolNode[],
	expected: SymbolNode[],
	kinds: SymbolKind[],
): void {
	for (const kind of kinds) {
		const rows = expected.filter((s) => s.kind === kind);
		expect(rows.length, kind).toBeGreaterThan(0);
		expect(
			actual.filter((s) => s.kind === kind),
			kind,
		).toStrictEqual(rows);
	}
}

const TS_EXPECTED: SymbolNode[] = [
	{
		qualifiedName: "plain",
		name: "plain",
		file: "symbols/ts.ts",
		kind: "function",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 2, column: 8, endLine: 4, endColumn: 1 },
		nameRange: { line: 2, column: 17, endLine: 2, endColumn: 21 },
	},
	{
		qualifiedName: "over",
		name: "over",
		file: "symbols/ts.ts",
		kind: "function",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: true,
		range: { line: 6, column: 8, endLine: 6, endColumn: 40 },
		nameRange: { line: 6, column: 17, endLine: 6, endColumn: 20 },
	},
	{
		qualifiedName: "over",
		name: "over",
		file: "symbols/ts.ts",
		kind: "function",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: true,
		range: { line: 7, column: 8, endLine: 7, endColumn: 40 },
		nameRange: { line: 7, column: 17, endLine: 7, endColumn: 20 },
	},
	{
		qualifiedName: "over",
		name: "over",
		file: "symbols/ts.ts",
		kind: "function",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 8, column: 8, endLine: 10, endColumn: 1 },
		nameRange: { line: 8, column: 17, endLine: 8, endColumn: 20 },
	},
	{
		qualifiedName: "arrow",
		name: "arrow",
		file: "symbols/ts.ts",
		kind: "function",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 12, column: 8, endLine: 12, endColumn: 42 },
		nameRange: { line: 12, column: 14, endLine: 12, endColumn: 18 },
	},
	{
		qualifiedName: "fnExpr",
		name: "fnExpr",
		file: "symbols/ts.ts",
		kind: "function",
		exported: false,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 13, column: 1, endLine: 15, endColumn: 2 },
		nameRange: { line: 13, column: 7, endLine: 13, endColumn: 12 },
	},
	{
		qualifiedName: "default",
		name: "default",
		file: "symbols/ts.ts",
		kind: "function",
		exported: true,
		isDefaultExport: true,
		isDeclarationOnly: false,
		range: { line: 17, column: 16, endLine: 19, endColumn: 1 },
		nameRange: { line: 17, column: 8, endLine: 17, endColumn: 14 },
	},
	{
		qualifiedName: "Service",
		name: "Service",
		file: "symbols/ts.ts",
		kind: "class",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 21, column: 8, endLine: 26, endColumn: 1 },
		nameRange: { line: 21, column: 14, endLine: 21, endColumn: 20 },
	},
	{
		qualifiedName: "Service.count",
		name: "count",
		file: "symbols/ts.ts",
		kind: "property",
		containerQualifiedName: "Service",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 22, column: 2, endLine: 22, endColumn: 10 },
		nameRange: { line: 22, column: 2, endLine: 22, endColumn: 6 },
	},
	{
		qualifiedName: "Service.run",
		name: "run",
		file: "symbols/ts.ts",
		kind: "method",
		containerQualifiedName: "Service",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 23, column: 2, endLine: 25, endColumn: 2 },
		nameRange: { line: 23, column: 2, endLine: 23, endColumn: 4 },
	},
	{
		qualifiedName: "Base",
		name: "Base",
		file: "symbols/ts.ts",
		kind: "class",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 28, column: 8, endLine: 30, endColumn: 1 },
		nameRange: { line: 28, column: 23, endLine: 28, endColumn: 26 },
	},
	{
		qualifiedName: "Base.shape",
		name: "shape",
		file: "symbols/ts.ts",
		kind: "method",
		containerQualifiedName: "Base",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: true,
		range: { line: 29, column: 2, endLine: 29, endColumn: 25 },
		nameRange: { line: 29, column: 11, endLine: 29, endColumn: 15 },
	},
	{
		qualifiedName: "Expr",
		name: "Expr",
		file: "symbols/ts.ts",
		kind: "class",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 32, column: 8, endLine: 32, endColumn: 29 },
		nameRange: { line: 32, column: 14, endLine: 32, endColumn: 17 },
	},
	{
		qualifiedName: "Shape",
		name: "Shape",
		file: "symbols/ts.ts",
		kind: "interface",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 34, column: 8, endLine: 37, endColumn: 1 },
		nameRange: { line: 34, column: 18, endLine: 34, endColumn: 22 },
	},
	{
		qualifiedName: "Shape.area",
		name: "area",
		file: "symbols/ts.ts",
		kind: "property",
		containerQualifiedName: "Shape",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: true,
		range: { line: 35, column: 2, endLine: 35, endColumn: 13 },
		nameRange: { line: 35, column: 2, endLine: 35, endColumn: 5 },
	},
	{
		qualifiedName: "Shape.describe",
		name: "describe",
		file: "symbols/ts.ts",
		kind: "method",
		containerQualifiedName: "Shape",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: true,
		range: { line: 36, column: 2, endLine: 36, endColumn: 19 },
		nameRange: { line: 36, column: 2, endLine: 36, endColumn: 9 },
	},
	{
		qualifiedName: "Id",
		name: "Id",
		file: "symbols/ts.ts",
		kind: "type",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 39, column: 8, endLine: 39, endColumn: 33 },
		nameRange: { line: 39, column: 13, endLine: 39, endColumn: 14 },
	},
	{
		qualifiedName: "Color",
		name: "Color",
		file: "symbols/ts.ts",
		kind: "enum",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 41, column: 8, endLine: 44, endColumn: 1 },
		nameRange: { line: 41, column: 13, endLine: 41, endColumn: 17 },
	},
	{
		qualifiedName: "Color.Red",
		name: "Red",
		file: "symbols/ts.ts",
		kind: "enum_member",
		containerQualifiedName: "Color",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 42, column: 2, endLine: 42, endColumn: 4 },
		nameRange: { line: 42, column: 2, endLine: 42, endColumn: 4 },
	},
	{
		qualifiedName: "Color.Green",
		name: "Green",
		file: "symbols/ts.ts",
		kind: "enum_member",
		containerQualifiedName: "Color",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 43, column: 2, endLine: 43, endColumn: 16 },
		nameRange: { line: 43, column: 2, endLine: 43, endColumn: 6 },
	},
	{
		qualifiedName: "limit",
		name: "limit",
		file: "symbols/ts.ts",
		kind: "variable",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 46, column: 8, endLine: 46, endColumn: 24 },
		nameRange: { line: 46, column: 14, endLine: 46, endColumn: 18 },
	},
	{
		qualifiedName: "counter",
		name: "counter",
		file: "symbols/ts.ts",
		kind: "variable",
		exported: false,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 47, column: 1, endLine: 47, endColumn: 16 },
		nameRange: { line: 47, column: 5, endLine: 47, endColumn: 11 },
	},
	{
		qualifiedName: "left",
		name: "left",
		file: "symbols/ts.ts",
		kind: "variable",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 48, column: 8, endLine: 48, endColumn: 53 },
		nameRange: { line: 48, column: 16, endLine: 48, endColumn: 19 },
	},
	{
		qualifiedName: "right",
		name: "right",
		file: "symbols/ts.ts",
		kind: "variable",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 48, column: 8, endLine: 48, endColumn: 53 },
		nameRange: { line: 48, column: 22, endLine: 48, endColumn: 26 },
	},
	{
		qualifiedName: "Geo",
		name: "Geo",
		file: "symbols/ts.ts",
		kind: "namespace",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 50, column: 8, endLine: 55, endColumn: 1 },
		nameRange: { line: 50, column: 18, endLine: 50, endColumn: 20 },
	},
	{
		qualifiedName: "Geo.dist",
		name: "dist",
		file: "symbols/ts.ts",
		kind: "function",
		containerQualifiedName: "Geo",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 51, column: 9, endLine: 53, endColumn: 2 },
		nameRange: { line: 51, column: 18, endLine: 51, endColumn: 21 },
	},
	{
		qualifiedName: "Geo.origin",
		name: "origin",
		file: "symbols/ts.ts",
		kind: "variable",
		containerQualifiedName: "Geo",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 54, column: 9, endLine: 54, endColumn: 25 },
		nameRange: { line: 54, column: 15, endLine: 54, endColumn: 20 },
	},
	{
		qualifiedName: "external",
		name: "external",
		file: "symbols/ts.ts",
		kind: "function",
		exported: false,
		isDefaultExport: false,
		isDeclarationOnly: true,
		range: { line: 57, column: 9, endLine: 57, endColumn: 34 },
		nameRange: { line: 57, column: 18, endLine: 57, endColumn: 25 },
	},
];

const PY_EXPECTED: SymbolNode[] = [
	{
		qualifiedName: "LIMIT",
		name: "LIMIT",
		file: "symbols/py.py",
		kind: "variable",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 4, column: 1, endLine: 4, endColumn: 10 },
		nameRange: { line: 4, column: 1, endLine: 4, endColumn: 5 },
	},
	{
		qualifiedName: "name",
		name: "name",
		file: "symbols/py.py",
		kind: "variable",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 5, column: 1, endLine: 5, endColumn: 22 },
		nameRange: { line: 5, column: 1, endLine: 5, endColumn: 4 },
	},
	{
		qualifiedName: "other",
		name: "other",
		file: "symbols/py.py",
		kind: "variable",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 5, column: 1, endLine: 5, endColumn: 22 },
		nameRange: { line: 5, column: 7, endLine: 5, endColumn: 11 },
	},
	{
		qualifiedName: "helper",
		name: "helper",
		file: "symbols/py.py",
		kind: "function",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 8, column: 1, endLine: 9, endColumn: 12 },
		nameRange: { line: 8, column: 5, endLine: 8, endColumn: 10 },
	},
	{
		qualifiedName: "Service",
		name: "Service",
		file: "symbols/py.py",
		kind: "class",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 12, column: 1, endLine: 17, endColumn: 33 },
		nameRange: { line: 12, column: 7, endLine: 12, endColumn: 13 },
	},
	{
		qualifiedName: "Service.__init__",
		name: "__init__",
		file: "symbols/py.py",
		kind: "method",
		containerQualifiedName: "Service",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 13, column: 5, endLine: 14, endColumn: 22 },
		nameRange: { line: 13, column: 9, endLine: 13, endColumn: 16 },
	},
	{
		qualifiedName: "Service.run",
		name: "run",
		file: "symbols/py.py",
		kind: "method",
		containerQualifiedName: "Service",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 16, column: 5, endLine: 17, endColumn: 33 },
		nameRange: { line: 16, column: 9, endLine: 16, endColumn: 11 },
	},
	{
		qualifiedName: "Child",
		name: "Child",
		file: "symbols/py.py",
		kind: "class",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 20, column: 1, endLine: 21, endColumn: 8 },
		nameRange: { line: 20, column: 7, endLine: 20, endColumn: 11 },
	},
];

const CPP_EXPECTED: SymbolNode[] = [
	{
		qualifiedName: "LIMIT",
		name: "LIMIT",
		file: "symbols/c.cpp",
		kind: "macro",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 2, column: 1, endLine: 2, endColumn: 16 },
		nameRange: { line: 2, column: 9, endLine: 2, endColumn: 13 },
	},
	{
		qualifiedName: "SQUARE",
		name: "SQUARE",
		file: "symbols/c.cpp",
		kind: "macro",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 3, column: 1, endLine: 3, endColumn: 29 },
		nameRange: { line: 3, column: 9, endLine: 3, endColumn: 14 },
	},
	{
		qualifiedName: "prototype",
		name: "prototype",
		file: "symbols/c.cpp",
		kind: "function",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: true,
		range: { line: 5, column: 1, endLine: 5, endColumn: 21 },
		nameRange: { line: 5, column: 5, endLine: 5, endColumn: 13 },
	},
	{
		qualifiedName: "counter",
		name: "counter",
		file: "symbols/c.cpp",
		kind: "variable",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 7, column: 1, endLine: 7, endColumn: 16 },
		nameRange: { line: 7, column: 5, endLine: 7, endColumn: 11 },
	},
	{
		qualifiedName: "hidden",
		name: "hidden",
		file: "symbols/c.cpp",
		kind: "variable",
		exported: false,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 8, column: 1, endLine: 8, endColumn: 22 },
		nameRange: { line: 8, column: 12, endLine: 8, endColumn: 17 },
	},
	{
		qualifiedName: "uint_t",
		name: "uint_t",
		file: "symbols/c.cpp",
		kind: "type",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 10, column: 1, endLine: 10, endColumn: 28 },
		nameRange: { line: 10, column: 22, endLine: 10, endColumn: 27 },
	},
	{
		qualifiedName: "Color",
		name: "Color",
		file: "symbols/c.cpp",
		kind: "enum",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 12, column: 1, endLine: 12, endColumn: 25 },
		nameRange: { line: 12, column: 6, endLine: 12, endColumn: 10 },
	},
	{
		qualifiedName: "Color.Red",
		name: "Red",
		file: "symbols/c.cpp",
		kind: "enum_member",
		containerQualifiedName: "Color",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 12, column: 14, endLine: 12, endColumn: 16 },
		nameRange: { line: 12, column: 14, endLine: 12, endColumn: 16 },
	},
	{
		qualifiedName: "Color.Green",
		name: "Green",
		file: "symbols/c.cpp",
		kind: "enum_member",
		containerQualifiedName: "Color",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 12, column: 19, endLine: 12, endColumn: 23 },
		nameRange: { line: 12, column: 19, endLine: 12, endColumn: 23 },
	},
	{
		qualifiedName: "Point",
		name: "Point",
		file: "symbols/c.cpp",
		kind: "struct",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 14, column: 1, endLine: 17, endColumn: 1 },
		nameRange: { line: 14, column: 8, endLine: 14, endColumn: 12 },
	},
	{
		qualifiedName: "Point.x",
		name: "x",
		file: "symbols/c.cpp",
		kind: "property",
		containerQualifiedName: "Point",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 15, column: 2, endLine: 15, endColumn: 7 },
		nameRange: { line: 15, column: 6, endLine: 15, endColumn: 6 },
	},
	{
		qualifiedName: "Point.y",
		name: "y",
		file: "symbols/c.cpp",
		kind: "property",
		containerQualifiedName: "Point",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 16, column: 2, endLine: 16, endColumn: 7 },
		nameRange: { line: 16, column: 6, endLine: 16, endColumn: 6 },
	},
	{
		qualifiedName: "Value",
		name: "Value",
		file: "symbols/c.cpp",
		kind: "struct",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 19, column: 1, endLine: 22, endColumn: 1 },
		nameRange: { line: 19, column: 7, endLine: 19, endColumn: 11 },
	},
	{
		qualifiedName: "Value.i",
		name: "i",
		file: "symbols/c.cpp",
		kind: "property",
		containerQualifiedName: "Value",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 20, column: 2, endLine: 20, endColumn: 7 },
		nameRange: { line: 20, column: 6, endLine: 20, endColumn: 6 },
	},
	{
		qualifiedName: "Value.f",
		name: "f",
		file: "symbols/c.cpp",
		kind: "property",
		containerQualifiedName: "Value",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 21, column: 2, endLine: 21, endColumn: 9 },
		nameRange: { line: 21, column: 8, endLine: 21, endColumn: 8 },
	},
	{
		qualifiedName: "Widget",
		name: "Widget",
		file: "symbols/c.cpp",
		kind: "class",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 24, column: 1, endLine: 29, endColumn: 1 },
		nameRange: { line: 24, column: 7, endLine: 24, endColumn: 12 },
	},
	{
		qualifiedName: "Widget.size",
		name: "size",
		file: "symbols/c.cpp",
		kind: "property",
		containerQualifiedName: "Widget",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 26, column: 2, endLine: 26, endColumn: 10 },
		nameRange: { line: 26, column: 6, endLine: 26, endColumn: 9 },
	},
	{
		qualifiedName: "Widget.area",
		name: "area",
		file: "symbols/c.cpp",
		kind: "method",
		containerQualifiedName: "Widget",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 27, column: 2, endLine: 27, endColumn: 35 },
		nameRange: { line: 27, column: 6, endLine: 27, endColumn: 9 },
	},
	{
		qualifiedName: "Widget.resize",
		name: "resize",
		file: "symbols/c.cpp",
		kind: "method",
		containerQualifiedName: "Widget",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: true,
		range: { line: 28, column: 2, endLine: 28, endColumn: 20 },
		nameRange: { line: 28, column: 7, endLine: 28, endColumn: 12 },
	},
	{
		qualifiedName: "Widget.resize",
		name: "resize",
		file: "symbols/c.cpp",
		kind: "method",
		containerQualifiedName: "Widget",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 31, column: 1, endLine: 31, endColumn: 40 },
		nameRange: { line: 31, column: 14, endLine: 31, endColumn: 19 },
	},
	{
		qualifiedName: "geo.dist",
		name: "dist",
		file: "symbols/c.cpp",
		kind: "function",
		containerQualifiedName: "geo",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 34, column: 2, endLine: 34, endColumn: 30 },
		nameRange: { line: 34, column: 6, endLine: 34, endColumn: 9 },
	},
	{
		qualifiedName: "prototype",
		name: "prototype",
		file: "symbols/c.cpp",
		kind: "function",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 37, column: 1, endLine: 37, endColumn: 42 },
		nameRange: { line: 37, column: 5, endLine: 37, endColumn: 13 },
	},
	{
		qualifiedName: "local_helper",
		name: "local_helper",
		file: "symbols/c.cpp",
		kind: "function",
		exported: false,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 39, column: 1, endLine: 39, endColumn: 39 },
		nameRange: { line: 39, column: 12, endLine: 39, endColumn: 23 },
	},
];

const C_EXPECTED: SymbolNode[] = [
	{
		qualifiedName: "MAX",
		name: "MAX",
		file: "symbols/c.c",
		kind: "macro",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 2, column: 1, endLine: 2, endColumn: 13 },
		nameRange: { line: 2, column: 9, endLine: 2, endColumn: 11 },
	},
	{
		qualifiedName: "TWICE",
		name: "TWICE",
		file: "symbols/c.c",
		kind: "macro",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 3, column: 1, endLine: 3, endColumn: 26 },
		nameRange: { line: 3, column: 9, endLine: 3, endColumn: 13 },
	},
	{
		qualifiedName: "Node",
		name: "Node",
		file: "symbols/c.c",
		kind: "type",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 5, column: 1, endLine: 8, endColumn: 7 },
		nameRange: { line: 8, column: 3, endLine: 8, endColumn: 6 },
	},
	{
		qualifiedName: "Node",
		name: "Node",
		file: "symbols/c.c",
		kind: "struct",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 5, column: 9, endLine: 8, endColumn: 1 },
		nameRange: { line: 5, column: 16, endLine: 5, endColumn: 19 },
	},
	{
		qualifiedName: "Node.value",
		name: "value",
		file: "symbols/c.c",
		kind: "property",
		containerQualifiedName: "Node",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 6, column: 2, endLine: 6, endColumn: 11 },
		nameRange: { line: 6, column: 6, endLine: 6, endColumn: 10 },
	},
	{
		qualifiedName: "Node.next",
		name: "next",
		file: "symbols/c.c",
		kind: "property",
		containerQualifiedName: "Node",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 7, column: 2, endLine: 7, endColumn: 19 },
		nameRange: { line: 7, column: 15, endLine: 7, endColumn: 18 },
	},
	{
		qualifiedName: "Mode",
		name: "Mode",
		file: "symbols/c.c",
		kind: "enum",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 10, column: 1, endLine: 10, endColumn: 32 },
		nameRange: { line: 10, column: 6, endLine: 10, endColumn: 9 },
	},
	{
		qualifiedName: "Mode.MODE_A",
		name: "MODE_A",
		file: "symbols/c.c",
		kind: "enum_member",
		containerQualifiedName: "Mode",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 10, column: 13, endLine: 10, endColumn: 18 },
		nameRange: { line: 10, column: 13, endLine: 10, endColumn: 18 },
	},
	{
		qualifiedName: "Mode.MODE_B",
		name: "MODE_B",
		file: "symbols/c.c",
		kind: "enum_member",
		containerQualifiedName: "Mode",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 10, column: 21, endLine: 10, endColumn: 30 },
		nameRange: { line: 10, column: 21, endLine: 10, endColumn: 26 },
	},
	{
		qualifiedName: "Slot",
		name: "Slot",
		file: "symbols/c.c",
		kind: "struct",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 12, column: 1, endLine: 15, endColumn: 1 },
		nameRange: { line: 12, column: 7, endLine: 12, endColumn: 10 },
	},
	{
		qualifiedName: "Slot.i",
		name: "i",
		file: "symbols/c.c",
		kind: "property",
		containerQualifiedName: "Slot",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 13, column: 2, endLine: 13, endColumn: 7 },
		nameRange: { line: 13, column: 6, endLine: 13, endColumn: 6 },
	},
	{
		qualifiedName: "Slot.c",
		name: "c",
		file: "symbols/c.c",
		kind: "property",
		containerQualifiedName: "Slot",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 14, column: 2, endLine: 14, endColumn: 8 },
		nameRange: { line: 14, column: 7, endLine: 14, endColumn: 7 },
	},
	{
		qualifiedName: "total",
		name: "total",
		file: "symbols/c.c",
		kind: "variable",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 17, column: 1, endLine: 17, endColumn: 14 },
		nameRange: { line: 17, column: 5, endLine: 17, endColumn: 9 },
	},
	{
		qualifiedName: "cache",
		name: "cache",
		file: "symbols/c.c",
		kind: "variable",
		exported: false,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 18, column: 1, endLine: 18, endColumn: 17 },
		nameRange: { line: 18, column: 12, endLine: 18, endColumn: 16 },
	},
	{
		qualifiedName: "add",
		name: "add",
		file: "symbols/c.c",
		kind: "function",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: true,
		range: { line: 20, column: 1, endLine: 20, endColumn: 22 },
		nameRange: { line: 20, column: 5, endLine: 20, endColumn: 7 },
	},
	{
		qualifiedName: "add",
		name: "add",
		file: "symbols/c.c",
		kind: "function",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 22, column: 1, endLine: 25, endColumn: 1 },
		nameRange: { line: 22, column: 5, endLine: 22, endColumn: 7 },
	},
	{
		qualifiedName: "reset",
		name: "reset",
		file: "symbols/c.c",
		kind: "function",
		exported: false,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 27, column: 1, endLine: 27, endColumn: 38 },
		nameRange: { line: 27, column: 13, endLine: 27, endColumn: 17 },
	},
];

let tsAdapter: LanguageAdapter;
let pyAdapter: LanguageAdapter;
let cppAdapter: LanguageAdapter;
let cAdapter: LanguageAdapter;

beforeAll(async () => {
	tsAdapter = await createTypescriptAdapter();
	pyAdapter = await createPythonAdapter();
	cppAdapter = await createCppAdapter();
	cAdapter = await createCAdapter();
});

describe("adapter symbol fixtures (Section C)", () => {
	it("TS: emits the complete expected symbol rows", async () => {
		expect(await symbolsOf(tsAdapter, "symbols/ts.ts")).toStrictEqual(TS_EXPECTED);
	});

	it("TS: every kind in TS_SYMBOL_KINDS appears with its expected rows", async () => {
		expectEveryKind(
			await symbolsOf(tsAdapter, "symbols/ts.ts"),
			TS_EXPECTED,
			TS_SYMBOL_KINDS,
		);
	});

	it("TS: an export interface has its name on the declaration line, after the declaration start", async () => {
		const shape = (await symbolsOf(tsAdapter, "symbols/ts.ts")).find(
			(s) => s.qualifiedName === "Shape",
		)!;
		expect(shape.kind).toBe("interface");
		expect(shape.nameRange.line).toBe(shape.range.line);
		expect(shape.nameRange.column).toBeGreaterThan(shape.range.column);
	});

	it("Python: emits the complete expected symbol rows", async () => {
		expect(await symbolsOf(pyAdapter, "symbols/py.py")).toStrictEqual(PY_EXPECTED);
	});

	it("Python: every kind in PY_SYMBOL_KINDS appears with its expected rows", async () => {
		expectEveryKind(
			await symbolsOf(pyAdapter, "symbols/py.py"),
			PY_EXPECTED,
			PY_SYMBOL_KINDS,
		);
	});

	it("C++: emits the complete expected symbol rows", async () => {
		expect(await symbolsOf(cppAdapter, "symbols/c.cpp")).toStrictEqual(CPP_EXPECTED);
	});

	it("C++: every kind in C_SYMBOL_KINDS appears with its expected rows", async () => {
		expectEveryKind(
			await symbolsOf(cppAdapter, "symbols/c.cpp"),
			CPP_EXPECTED,
			C_SYMBOL_KINDS,
		);
	});

	it("C: emits the complete expected symbol rows", async () => {
		expect(await symbolsOf(cAdapter, "symbols/c.c")).toStrictEqual(C_EXPECTED);
	});

	it("C: every C_SYMBOL_KINDS kind the C grammar has appears with its expected rows", async () => {
		expectEveryKind(
			await symbolsOf(cAdapter, "symbols/c.c"),
			C_EXPECTED,
			C_SYMBOL_KINDS.filter((k) => k !== "class" && k !== "method"),
		);
	});
});

// ---------- functionsFromSymbols parity with the pre-3.2 functions ----------

type SnapshotEntry = { file: string; functions: FunctionNode[] };

const SNAPSHOT: SnapshotEntry[] = JSON.parse(
	fs.readFileSync(path.join(FIXTURES, "symbols/functions-3.1.json"), "utf8"),
);

const C_FAMILY = /\.(c|cpp|cc|cxx|h|hpp|hh|hxx)$/u;

/** Keys 3.1 emitted that 3.2 no longer does. A2 "Scope": function-local
 *  declarations are not emitted (`close` is a method of an object literal
 *  returned inside `open`). */
const REMOVED: Record<string, string[]> = {
	"nav-acceptance/electron/code-nav/cortex-index-service.ts": [
		"CortexIndexService.close",
	],
};

/** 3.1 qualified names that 3.2 qualifies by their container. A2: a
 *  qualified name is the container path joined with `.`, and A2.1 makes a TS
 *  `namespace` a container. */
const RENAMED: Record<string, Record<string, string>> = {
	"nav-acceptance/electron/code-nav/namespaced-service.ts": {
		C: "N.C",
		"C.open": "N.C.open",
		"C.run": "N.C.run",
		open: "N.open",
	},
	"symbols/ts.ts": { dist: "Geo.dist" },
};

/** Keys 3.2 projects that 3.1 did not emit. A2.2 projects every `function`,
 *  `method`, and `class` symbol, taking a declaration-only row when the key
 *  has no implementation, and A2.1 assigns these nodes those kinds. */
const ADDED: Record<string, string[]> = {
	// A2.1 Python `class`: `class_definition`.
	"python-basic/mypackage/models.py": ["Model"],
	"symbols/py.py": ["Service", "Child"],
	// A2.1 C-family `class`: `class_specifier`.
	"symbols/c.cpp": ["Widget"],
	// A2.1 TS `class`: `abstract_class_declaration` and a class expression
	// assigned to a const. A2.2 rule 2 and B2: an abstract method, an
	// interface method signature, and a `declare` function are
	// declaration-only rows that project when no implementation exists.
	"symbols/ts.ts": ["Base", "Base.shape", "Expr", "Shape.describe", "external"],
};

/** The 3.1 rows rewritten by the intended 3.2 changes, in 3.2 order. */
function expectedFor(entry: SnapshotEntry): FunctionNode[] {
	const removed = new Set(REMOVED[entry.file] ?? []);
	const renamed = RENAMED[entry.file] ?? {};
	const cFamily = C_FAMILY.test(entry.file);
	const rows = entry.functions
		.filter((f) => !removed.has(f.qualifiedName))
		.map((f) => {
			let qualifiedName = renamed[f.qualifiedName] ?? f.qualifiedName;
			// Decision 3 and B2: C-family qualified names join with `.`, not `::`.
			if (cFamily) qualifiedName = qualifiedName.replaceAll("::", ".");
			// A2.2: the projected row is the symbols row verbatim, and
			// `is_declaration_only` is NOT NULL (A2), so 3.1 rows that omitted
			// the flag carry `false`.
			return {
				...f,
				qualifiedName,
				isDeclarationOnly: f.isDeclarationOnly ?? false,
			};
		});
	// A2.2: one row per key, the first implementation in source order, else
	// the first declaration-only row, at the key's first-seen position. This
	// drops a same-file C prototype that precedes its definition.
	const chosen = new Map<string, FunctionNode>();
	for (const f of rows) {
		const key = symbolKey(f.file, f.qualifiedName);
		const prev = chosen.get(key);
		if (!prev || (prev.isDeclarationOnly && !f.isDeclarationOnly))
			chosen.set(key, f);
	}
	return [...chosen.values()];
}

describe("functionsFromSymbols reproduces the pre-3.2 functions (Section C)", () => {
	beforeAll(async () => {
		await ensureAdapters();
	});

	it("covers every call-graph fixture file", () => {
		expect(SNAPSHOT.map((e) => e.file)).toStrictEqual([
			"c-cpp-mixed/src/main.cpp",
			"c-cpp-mixed/src/main.ts",
			"c-cpp-mixed/src/utils.cpp",
			"c-cpp-mixed/src/utils.h",
			"deep-repo/src/components/Panel.tsx",
			"deep-repo/src/features/mywork/CardTitleEditor.tsx",
			"deep-repo/src/features/mywork/index.ts",
			"nav-acceptance/electron/code-nav/cortex-index-service.ts",
			"nav-acceptance/electron/code-nav/namespaced-service.ts",
			"nav-acceptance/electron/code-nav/types.ts",
			"python-basic/main.py",
			"python-basic/mypackage/__init__.py",
			"python-basic/mypackage/models.py",
			"python-basic/mypackage/utils.py",
			"symbols/c.c",
			"symbols/c.cpp",
			"symbols/py.py",
			"symbols/ts.ts",
		]);
	});

	for (const entry of SNAPSHOT) {
		it(`matches the 3.1 functions for ${entry.file}`, async () => {
			const r = await getAdapterForFile(entry.file)!.extractCallGraph!(
				FIXTURES,
				entry.file,
			);
			const actual = functionsFromSymbols(r.symbols);
			const added = new Set(ADDED[entry.file] ?? []);
			expect(
				actual.filter((f) => !added.has(f.qualifiedName)),
			).toStrictEqual(expectedFor(entry));
			expect(
				actual
					.filter((f) => added.has(f.qualifiedName))
					.map((f) => f.qualifiedName),
			).toStrictEqual([...added]);
		});
	}
});
