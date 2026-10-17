// tests/unit/lib/symbols.test.ts
import { describe, expect, it } from "vitest";
import {
	functionsFromSymbols,
	symbolKey,
	navCapabilities,
} from "../../../src/lib/symbols.js";
import type { SymbolNode } from "../../../src/lib/models.js";

function sym(over: Partial<SymbolNode>): SymbolNode {
	return {
		qualifiedName: "foo",
		name: "foo",
		file: "src/a.ts",
		kind: "function",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: { line: 1, column: 1, endLine: 3, endColumn: 1 },
		nameRange: { line: 1, column: 17, endLine: 1, endColumn: 20 },
		...over,
	};
}

describe("symbolKey", () => {
	it("joins file and qualified name with ::", () => {
		expect(symbolKey("src/a.ts", "Cls.m")).toBe("src/a.ts::Cls.m");
	});
});

describe("functionsFromSymbols (A2.2 projection)", () => {
	it("keeps only function, method, class kinds", () => {
		const out = functionsFromSymbols([
			sym({ kind: "function", qualifiedName: "f", name: "f" }),
			sym({ kind: "interface", qualifiedName: "I", name: "I" }),
			sym({ kind: "variable", qualifiedName: "v", name: "v" }),
			sym({ kind: "class", qualifiedName: "C", name: "C" }),
			sym({ kind: "method", qualifiedName: "C.m", name: "m" }),
		]);
		expect(out.map((f) => f.qualifiedName)).toEqual(["f", "C", "C.m"]);
	});

	it("maps SymbolNode fields onto the FunctionNode shape verbatim", () => {
		const [fn] = functionsFromSymbols([
			sym({
				range: { line: 4, column: 2, endLine: 9, endColumn: 3 },
				exported: false,
				isDefaultExport: true,
				isDeclarationOnly: true,
			}),
		]);
		expect(fn).toEqual({
			qualifiedName: "foo",
			file: "src/a.ts",
			exported: false,
			isDefaultExport: true,
			line: 4,
			column: 2,
			endLine: 9,
			endColumn: 3,
			isDeclarationOnly: true,
		});
	});

	it("collapses overload signatures plus implementation to the implementation", () => {
		const out = functionsFromSymbols([
			sym({ isDeclarationOnly: true, range: { line: 1, column: 1, endLine: 1, endColumn: 30 } }),
			sym({ isDeclarationOnly: true, range: { line: 2, column: 1, endLine: 2, endColumn: 30 } }),
			sym({ isDeclarationOnly: false, range: { line: 3, column: 1, endLine: 6, endColumn: 2 } }),
		]);
		expect(out).toHaveLength(1);
		expect(out[0].line).toBe(3);
		expect(out[0].isDeclarationOnly).toBe(false);
	});

	it("falls back to the first declaration-only row in input order when no implementation exists", () => {
		// Adapters emit rows in document order, so input order is source order (A2.2).
		// The helper must not re-sort by line: for one key all rows come from one parse.
		const out = functionsFromSymbols([
			sym({ isDeclarationOnly: true, range: { line: 7, column: 1, endLine: 7, endColumn: 30 } }),
			sym({ isDeclarationOnly: true, range: { line: 9, column: 1, endLine: 9, endColumn: 30 } }),
		]);
		expect(out).toHaveLength(1);
		expect(out[0].line).toBe(7);
	});

	it("an implementation after several signatures wins regardless of position", () => {
		const out = functionsFromSymbols([
			sym({ isDeclarationOnly: true, range: { line: 1, column: 1, endLine: 1, endColumn: 30 } }),
			sym({ isDeclarationOnly: false, range: { line: 8, column: 1, endLine: 10, endColumn: 2 } }),
			sym({ isDeclarationOnly: true, range: { line: 12, column: 1, endLine: 12, endColumn: 30 } }),
		]);
		expect(out.map((f) => f.line)).toEqual([8]);
	});

	it("keeps same qualified name in different files as distinct keys", () => {
		const out = functionsFromSymbols([
			sym({ file: "src/a.ts" }),
			sym({ file: "src/b.ts" }),
		]);
		expect(out.map((f) => f.file)).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("preserves first-seen key order", () => {
		const out = functionsFromSymbols([
			sym({ qualifiedName: "z", name: "z" }),
			sym({ qualifiedName: "a", name: "a" }),
			sym({ qualifiedName: "z", name: "z", isDeclarationOnly: true }),
		]);
		expect(out.map((f) => f.qualifiedName)).toEqual(["z", "a"]);
	});
});

describe("navCapabilities", () => {
	it("advertises refs as the references table and the union of adapter kinds", () => {
		const caps = navCapabilities();
		expect(caps.symbols).toBe(true);
		expect(caps.references).toBe(true);
		expect(caps.referencesTable).toBe("refs");
		for (const k of ["function", "method", "class", "interface", "type", "enum", "enum_member", "variable", "property", "namespace", "struct", "macro"]) {
			expect(caps.symbolKinds).toContain(k);
		}
		for (const k of ["call", "new", "type", "extends", "implements", "import", "export", "member", "jsx", "decorator"]) {
			expect(caps.referenceKinds).toContain(k);
		}
		expect(caps.referenceKinds).not.toContain("read");
		expect(caps.referenceKinds).not.toContain("write");
	});
});
