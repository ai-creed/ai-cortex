// tests/unit/lib/call-graph.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../../src/lib/adapters/index.js");
vi.mock("../../../src/lib/import-graph.js");

import {
	getAdapterForFile,
	adapterSupports,
} from "../../../src/lib/adapters/index.js";
import { extractImports } from "../../../src/lib/import-graph.js";
import type {
	LanguageAdapter,
	RawCallSite,
	ImportBinding,
} from "../../../src/lib/lang-adapter.js";
import type {
	FunctionNode,
	ImportEdge,
	SymbolNode,
} from "../../../src/lib/models.js";
import { functionsFromSymbols } from "../../../src/lib/symbols.js";
import {
	resolveCallSites,
	extractCallGraph,
	resolvePythonTargetFile,
} from "../../../src/lib/call-graph.js";

describe("resolveCallSites", () => {
	it("threads RawCallSite.site onto a resolved CallEdge", () => {
		const raw: RawCallSite[] = [
			{
				callerQualifiedName: "foo",
				callerFile: "src/a.ts",
				rawCallee: "helper",
				kind: "call",
				site: { line: 2, column: 10, endLine: 2, endColumn: 18 },
			},
		];
		const funcs = [
			...functions,
			{
				qualifiedName: "helper",
				file: "src/a.ts",
				exported: false,
				isDefaultExport: false,
				line: 10,
			},
		];
		const edges = resolveCallSites(raw, funcs, new Map(), new Map());
		expect(edges[0].site).toEqual({
			line: 2,
			column: 10,
			endLine: 2,
			endColumn: 18,
		});
	});

	it("omits site key entirely when RawCallSite.site is absent", () => {
		const raw: RawCallSite[] = [
			{
				callerQualifiedName: "foo",
				callerFile: "src/a.ts",
				rawCallee: "helper",
				kind: "call",
			},
		];
		const funcs = [
			...functions,
			{
				qualifiedName: "helper",
				file: "src/a.ts",
				exported: false,
				isDefaultExport: false,
				line: 10,
			},
		];
		const edges = resolveCallSites(raw, funcs, new Map(), new Map());
		expect("site" in edges[0]).toBe(false);
	});

	it("attaches site to the unresolved-fallback edge (to starts with ::)", () => {
		const raw: RawCallSite[] = [
			{
				callerQualifiedName: "foo",
				callerFile: "src/a.ts",
				rawCallee: "totallyUnknownFn",
				kind: "call",
				site: { line: 7, column: 3, endLine: 7, endColumn: 20 },
			},
		];
		const edges = resolveCallSites(raw, functions, new Map(), new Map());
		expect(edges[0].to.startsWith("::")).toBe(true);
		expect(edges[0].site).toEqual({
			line: 7,
			column: 3,
			endLine: 7,
			endColumn: 20,
		});
	});

	const functions: FunctionNode[] = [
		{
			qualifiedName: "foo",
			file: "src/a.ts",
			exported: true,
			isDefaultExport: false,
			line: 1,
		},
		{
			qualifiedName: "bar",
			file: "src/b.ts",
			exported: true,
			isDefaultExport: false,
			line: 1,
		},
		{
			qualifiedName: "Svc.run",
			file: "src/b.ts",
			exported: true,
			isDefaultExport: false,
			line: 5,
		},
		{
			qualifiedName: "doThing",
			file: "src/c.ts",
			exported: true,
			isDefaultExport: true,
			line: 1,
		},
	];

	it("resolves same-file call", () => {
		const funcsWithHelper = [
			...functions,
			{
				qualifiedName: "helper",
				file: "src/a.ts",
				exported: false,
				isDefaultExport: false,
				line: 10,
			},
		];
		const rawCallsFixed: RawCallSite[] = [
			{
				callerQualifiedName: "foo",
				callerFile: "src/a.ts",
				rawCallee: "helper",
				kind: "call",
			},
		];
		const edges = resolveCallSites(
			rawCallsFixed,
			funcsWithHelper,
			new Map(),
			new Map(),
		);
		expect(edges).toContainEqual({
			from: "src/a.ts::foo",
			to: "src/a.ts::helper",
			kind: "call",
		});
	});

	it("resolves named import binding", () => {
		const rawCalls: RawCallSite[] = [
			{
				callerQualifiedName: "foo",
				callerFile: "src/a.ts",
				rawCallee: "bar",
				kind: "call",
			},
		];
		const bindings = new Map<string, ImportBinding[]>([
			[
				"src/a.ts",
				[
					{
						localName: "bar",
						importedName: "bar",
						fromSpecifier: "./b",
						bindingKind: "named",
					},
				],
			],
		]);
		const edges = resolveCallSites(rawCalls, functions, bindings, new Map());
		expect(edges).toContainEqual({
			from: "src/a.ts::foo",
			to: "src/b.ts::bar",
			kind: "call",
		});
	});

	it("resolves aliased import binding", () => {
		const rawCalls: RawCallSite[] = [
			{
				callerQualifiedName: "foo",
				callerFile: "src/a.ts",
				rawCallee: "myBar",
				kind: "call",
			},
		];
		const bindings = new Map<string, ImportBinding[]>([
			[
				"src/a.ts",
				[
					{
						localName: "myBar",
						importedName: "bar",
						fromSpecifier: "./b",
						bindingKind: "named",
					},
				],
			],
		]);
		const edges = resolveCallSites(rawCalls, functions, bindings, new Map());
		expect(edges).toContainEqual({
			from: "src/a.ts::foo",
			to: "src/b.ts::bar",
			kind: "call",
		});
	});

	it("resolves default import to named default export", () => {
		const rawCalls: RawCallSite[] = [
			{
				callerQualifiedName: "foo",
				callerFile: "src/a.ts",
				rawCallee: "Thing",
				kind: "call",
			},
		];
		const bindings = new Map<string, ImportBinding[]>([
			[
				"src/a.ts",
				[
					{
						localName: "Thing",
						importedName: "default",
						fromSpecifier: "./c",
						bindingKind: "default",
					},
				],
			],
		]);
		const edges = resolveCallSites(rawCalls, functions, bindings, new Map());
		expect(edges).toContainEqual({
			from: "src/a.ts::foo",
			to: "src/c.ts::doThing",
			kind: "call",
		});
	});

	it("resolves namespace import member access", () => {
		const rawCalls: RawCallSite[] = [
			{
				callerQualifiedName: "foo",
				callerFile: "src/a.ts",
				rawCallee: "b.bar",
				kind: "method",
			},
		];
		const bindings = new Map<string, ImportBinding[]>([
			[
				"src/a.ts",
				[
					{
						localName: "b",
						importedName: "*",
						fromSpecifier: "./b",
						bindingKind: "namespace",
					},
				],
			],
		]);
		const edges = resolveCallSites(rawCalls, functions, bindings, new Map());
		expect(edges).toContainEqual({
			from: "src/a.ts::foo",
			to: "src/b.ts::bar",
			kind: "method",
		});
	});

	it("falls back to ::bareMethod for unresolvable method call", () => {
		const rawCalls: RawCallSite[] = [
			{
				callerQualifiedName: "foo",
				callerFile: "src/a.ts",
				rawCallee: "obj.unknown",
				kind: "method",
			},
		];
		const edges = resolveCallSites(rawCalls, functions, new Map(), new Map());
		expect(edges).toContainEqual({
			from: "src/a.ts::foo",
			to: "::unknown",
			kind: "method",
		});
	});

	it("falls back to ::rawCallee for unresolvable plain call", () => {
		const rawCalls: RawCallSite[] = [
			{
				callerQualifiedName: "foo",
				callerFile: "src/a.ts",
				rawCallee: "mystery",
				kind: "call",
			},
		];
		const edges = resolveCallSites(rawCalls, functions, new Map(), new Map());
		expect(edges).toContainEqual({
			from: "src/a.ts::foo",
			to: "::mystery",
			kind: "call",
		});
	});
});

describe("resolveCallSites — overload ambiguity", () => {
	it("treats >1 same-file matches as unresolved", () => {
		const fns: FunctionNode[] = [
			{
				qualifiedName: "foo",
				file: "x.cpp",
				exported: true,
				isDefaultExport: false,
				line: 1,
			},
			{
				qualifiedName: "foo",
				file: "x.cpp",
				exported: true,
				isDefaultExport: false,
				line: 5,
			},
		];
		const calls: RawCallSite[] = [
			{
				callerQualifiedName: "main",
				callerFile: "x.cpp",
				rawCallee: "foo",
				kind: "call",
			},
		];
		const edges = resolveCallSites(
			calls,
			fns,
			new Map<string, ImportBinding[]>(),
			new Map(),
		);
		expect(edges).toEqual([{ from: "x.cpp::main", to: "::foo", kind: "call" }]);
	});

	it("links unique same-file match", () => {
		const fns: FunctionNode[] = [
			{
				qualifiedName: "foo",
				file: "x.ts",
				exported: true,
				isDefaultExport: false,
				line: 1,
			},
		];
		const calls: RawCallSite[] = [
			{
				callerQualifiedName: "main",
				callerFile: "x.ts",
				rawCallee: "foo",
				kind: "call",
			},
		];
		const edges = resolveCallSites(
			calls,
			fns,
			new Map<string, ImportBinding[]>(),
			new Map(),
		);
		expect(edges).toEqual([
			{ from: "x.ts::main", to: "x.ts::foo", kind: "call" },
		]);
	});
});

describe("resolveCallSites — includesByFile parameter", () => {
	it("accepts an empty includes map without throwing", () => {
		const edges = resolveCallSites([], [], new Map(), new Map());
		expect(edges).toEqual([]);
	});
});

describe("resolveCallSites — C/C++ includesByFile resolution", () => {
	it("resolves call to inline function defined in included header", () => {
		const fns: FunctionNode[] = [
			// Inline definition in header (not isDeclarationOnly)
			{
				qualifiedName: "helper",
				file: "src/utils.h",
				exported: true,
				isDefaultExport: false,
				line: 1,
				isDeclarationOnly: false,
			},
		];
		const calls: RawCallSite[] = [
			{
				callerQualifiedName: "main",
				callerFile: "src/main.cpp",
				rawCallee: "helper",
				kind: "call",
			},
		];
		const includesByFile = new Map([
			["src/main.cpp", [{ from: "src/main.cpp", to: "src/utils.h" }]],
		]);
		const edges = resolveCallSites(calls, fns, new Map(), includesByFile);
		expect(edges).toContainEqual({
			from: "src/main.cpp::main",
			to: "src/utils.h::helper",
			kind: "call",
		});
	});

	it("does not resolve decl-only function in included header", () => {
		const fns: FunctionNode[] = [
			// Declaration only in header
			{
				qualifiedName: "helper",
				file: "src/utils.h",
				exported: true,
				isDefaultExport: false,
				line: 1,
				isDeclarationOnly: true,
			},
		];
		const calls: RawCallSite[] = [
			{
				callerQualifiedName: "main",
				callerFile: "src/main.cpp",
				rawCallee: "helper",
				kind: "call",
			},
		];
		const includesByFile = new Map([
			["src/main.cpp", [{ from: "src/main.cpp", to: "src/utils.h" }]],
		]);
		const edges = resolveCallSites(calls, fns, new Map(), includesByFile);
		// Should fall back to unresolved
		expect(edges).toContainEqual(
			expect.objectContaining({ from: "src/main.cpp::main", to: "::helper" }),
		);
	});

	it("resolves to first matching included file when multiple headers are included", () => {
		const fns: FunctionNode[] = [
			{
				qualifiedName: "helper",
				file: "src/other.h",
				exported: true,
				isDefaultExport: false,
				line: 1,
				isDeclarationOnly: false,
			},
			{
				qualifiedName: "helper",
				file: "src/utils.h",
				exported: true,
				isDefaultExport: false,
				line: 1,
				isDeclarationOnly: false,
			},
		];
		const calls: RawCallSite[] = [
			{
				callerQualifiedName: "main",
				callerFile: "src/main.cpp",
				rawCallee: "helper",
				kind: "call",
			},
		];
		const includesByFile = new Map([
			[
				"src/main.cpp",
				[
					{ from: "src/main.cpp", to: "src/other.h" },
					{ from: "src/main.cpp", to: "src/utils.h" },
				],
			],
		]);
		const edges = resolveCallSites(calls, fns, new Map(), includesByFile);
		// Should resolve to the first included file that has a unique live definition
		expect(edges).toContainEqual({
			from: "src/main.cpp::main",
			to: "src/other.h::helper",
			kind: "call",
		});
	});

	it("skips included file with no matching function and falls through to next", () => {
		const fns: FunctionNode[] = [
			{
				qualifiedName: "helper",
				file: "src/utils.h",
				exported: true,
				isDefaultExport: false,
				line: 1,
				isDeclarationOnly: false,
			},
		];
		const calls: RawCallSite[] = [
			{
				callerQualifiedName: "main",
				callerFile: "src/main.cpp",
				rawCallee: "helper",
				kind: "call",
			},
		];
		const includesByFile = new Map([
			[
				"src/main.cpp",
				[
					{ from: "src/main.cpp", to: "src/unrelated.h" }, // no helper here
					{ from: "src/main.cpp", to: "src/utils.h" }, // helper is here
				],
			],
		]);
		const edges = resolveCallSites(calls, fns, new Map(), includesByFile);
		expect(edges).toContainEqual({
			from: "src/main.cpp::main",
			to: "src/utils.h::helper",
			kind: "call",
		});
	});
});

describe("resolveCallSites — C/C++ repo-wide unique fallback", () => {
	it("resolves unique repo-wide live definition for cfamily caller", () => {
		const fns: FunctionNode[] = [
			{
				qualifiedName: "helper",
				file: "src/utils.cpp",
				exported: true,
				isDefaultExport: false,
				line: 5,
				isDeclarationOnly: false,
			},
			// also a header decl — should be filtered
			{
				qualifiedName: "helper",
				file: "src/utils.h",
				exported: true,
				isDefaultExport: false,
				line: 1,
				isDeclarationOnly: true,
			},
		];
		const calls: RawCallSite[] = [
			{
				callerQualifiedName: "main",
				callerFile: "src/main.cpp",
				rawCallee: "helper",
				kind: "call",
			},
		];
		const edges = resolveCallSites(calls, fns, new Map(), new Map());
		expect(edges).toContainEqual({
			from: "src/main.cpp::main",
			to: "src/utils.cpp::helper",
			kind: "call",
		});
	});

	it("falls back to ::rawCallee when >1 live definition exists (ambiguous)", () => {
		const fns: FunctionNode[] = [
			{
				qualifiedName: "helper",
				file: "src/utils1.cpp",
				exported: true,
				isDefaultExport: false,
				line: 5,
				isDeclarationOnly: false,
			},
			{
				qualifiedName: "helper",
				file: "src/utils2.cpp",
				exported: true,
				isDefaultExport: false,
				line: 5,
				isDeclarationOnly: false,
			},
		];
		const calls: RawCallSite[] = [
			{
				callerQualifiedName: "main",
				callerFile: "src/main.cpp",
				rawCallee: "helper",
				kind: "call",
			},
		];
		const edges = resolveCallSites(calls, fns, new Map(), new Map());
		expect(edges).toContainEqual(expect.objectContaining({ to: "::helper" }));
	});

	it("does NOT apply repo-wide fallback for TS callers", () => {
		const fns: FunctionNode[] = [
			{
				qualifiedName: "helper",
				file: "src/utils.ts",
				exported: true,
				isDefaultExport: false,
				line: 5,
			},
		];
		const calls: RawCallSite[] = [
			{
				callerQualifiedName: "main",
				callerFile: "src/main.ts",
				rawCallee: "helper",
				kind: "call",
			},
		];
		// No bindings, no same-file match (different files)
		const edges = resolveCallSites(calls, fns, new Map(), new Map());
		// TS caller with no binding → fallback to ::helper (NOT resolved to utils.ts::helper)
		expect(edges).toContainEqual(expect.objectContaining({ to: "::helper" }));
	});
});

describe("resolveCallSites — decl-only never becomes a call edge target", () => {
	it("header prototype is in functions[] but call resolves to the definition", () => {
		const fns: FunctionNode[] = [
			// Header declaration
			{
				qualifiedName: "add",
				file: "src/utils.h",
				exported: true,
				isDefaultExport: false,
				line: 1,
				isDeclarationOnly: true,
			},
			// Live definition
			{
				qualifiedName: "add",
				file: "src/utils.cpp",
				exported: true,
				isDefaultExport: false,
				line: 3,
				isDeclarationOnly: false,
			},
		];
		const calls: RawCallSite[] = [
			{
				callerQualifiedName: "main",
				callerFile: "src/main.cpp",
				rawCallee: "add",
				kind: "call",
			},
		];
		const edges = resolveCallSites(calls, fns, new Map(), new Map());

		// The call must resolve to the definition, not the declaration
		expect(edges).toContainEqual({
			from: "src/main.cpp::main",
			to: "src/utils.cpp::add",
			kind: "call",
		});
		// It must NOT point to the header prototype
		expect(edges).not.toContainEqual(
			expect.objectContaining({ to: "src/utils.h::add" }),
		);
	});

	it("decl-only appears in functions[] output from extractCallGraph", async () => {
		// This tests the extractCallGraph path: header decl shows up in functions list
		const { createCppAdapter } =
			await import("../../../src/lib/adapters/cfamily.js");
		const cppAdapter = await createCppAdapter();
		const r = await cppAdapter.extractCallGraph!(
			"",
			"src/utils.h",
			"int add(int a, int b);", // declaration only
		);
		const decl = functionsFromSymbols(r.symbols).find((f) => f.qualifiedName === "add");
		expect(decl).toBeDefined();
		expect(decl?.isDeclarationOnly).toBe(true);
	});
});

describe("extractCallGraph", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("skips files with no adapter", async () => {
		vi.mocked(adapterSupports).mockReturnValue(false);
		vi.mocked(getAdapterForFile).mockReturnValue(null);
		vi.mocked(extractImports).mockResolvedValue([]);
		const result = await extractCallGraph("/repo", ["src/styles.css"]);
		expect(result.calls).toHaveLength(0);
		expect(result.functions).toHaveLength(0);
	});

	it("collects functions and resolved calls from adapter", async () => {
		const mockAdapter: LanguageAdapter = {
			extensions: [".ts"],
			capabilities: {
				importExtraction: true,
				callGraph: true,
				symbolIndex: false,
			},
			symbolKinds: [],
			referenceKinds: [],
			extractImports: vi.fn().mockResolvedValue([]),
			extractCallGraph: vi.fn().mockResolvedValue({
				symbols: [
					{
						qualifiedName: "main",
						name: "main",
						file: "src/main.ts",
						kind: "function",
						exported: true,
						isDefaultExport: false,
						isDeclarationOnly: false,
						range: { line: 1, column: 1, endLine: 3, endColumn: 1 },
						nameRange: { line: 1, column: 10, endLine: 1, endColumn: 14 },
					},
					{
						qualifiedName: "helper",
						name: "helper",
						file: "src/main.ts",
						kind: "function",
						exported: false,
						isDefaultExport: false,
						isDeclarationOnly: false,
						range: { line: 5, column: 1, endLine: 7, endColumn: 1 },
						nameRange: { line: 5, column: 10, endLine: 5, endColumn: 16 },
					},
				],
				rawCalls: [
					{
						callerQualifiedName: "main",
						callerFile: "src/main.ts",
						rawCallee: "helper",
						kind: "call",
					},
				],
				rawRefs: [],
				reexports: [],
				importBindings: [],
			}),
		};
		vi.mocked(adapterSupports).mockReturnValue(true);
		vi.mocked(getAdapterForFile).mockReturnValue(mockAdapter);
		vi.mocked(extractImports).mockResolvedValue([]);

		const result = await extractCallGraph("/repo", ["src/main.ts"]);
		expect(result.functions).toHaveLength(2);
		expect(result.calls).toContainEqual({
			from: "src/main.ts::main",
			to: "src/main.ts::helper",
			kind: "call",
		});
	});

	it("derives functions from adapter symbols and surfaces symbols and reexports", async () => {
		const sym = (file: string, qualifiedName: string): SymbolNode => ({
			qualifiedName,
			name: qualifiedName,
			file,
			kind: "function",
			exported: true,
			isDefaultExport: false,
			isDeclarationOnly: false,
			range: { line: 1, column: 1, endLine: 2, endColumn: 1 },
			nameRange: { line: 1, column: 10, endLine: 1, endColumn: 13 },
		});
		const adapter: LanguageAdapter = {
			extensions: [".ts"],
			capabilities: { importExtraction: true, callGraph: true, symbolIndex: true },
			symbolKinds: ["function"],
			referenceKinds: ["call"],
			async extractImports() { return []; },
			async extractCallGraph(_w, file) {
				return {
					symbols: [sym(file, "foo"), { ...sym(file, "foo"), isDeclarationOnly: true }],
					rawCalls: [],
					rawRefs: [],
					reexports: [{ file, exportedName: "x", sourceName: "y", specifier: "./z" }],
					importBindings: [],
				};
			},
		};
		vi.mocked(getAdapterForFile).mockReturnValue(adapter);
		vi.mocked(adapterSupports).mockReturnValue(true);
		vi.mocked(extractImports).mockResolvedValue([]);
		const r = await extractCallGraph("/repo", ["src/a.ts"]);
		expect(r.symbols).toHaveLength(2);
		expect(r.functions).toHaveLength(1);
		expect(r.functions[0]).toMatchObject({ qualifiedName: "foo", file: "src/a.ts", isDeclarationOnly: false, line: 1, column: 1, endLine: 2, endColumn: 1 });
		expect(r.reexports).toEqual([{ file: "src/a.ts", exportedName: "x", sourceName: "y", specifier: "./z" }]);
		expect(r.refs).toEqual([]);
	});

	it("calls extractImports with the file list and passes results to resolver", async () => {
		const mockAdapter: LanguageAdapter = {
			extensions: [".cpp"],
			capabilities: {
				importExtraction: true,
				callGraph: true,
				symbolIndex: false,
			},
			symbolKinds: [],
			referenceKinds: [],
			extractImports: vi.fn().mockResolvedValue([]),
			extractCallGraph: vi
				.fn()
				.mockResolvedValue({
					symbols: [],
					rawCalls: [],
					rawRefs: [],
					reexports: [],
					importBindings: [],
				}),
		};
		vi.mocked(adapterSupports).mockReturnValue(true);
		vi.mocked(getAdapterForFile).mockReturnValue(mockAdapter);
		vi.mocked(extractImports).mockResolvedValue([]);

		await extractCallGraph("/repo", ["src/main.cpp"]);
		expect(vi.mocked(extractImports)).toHaveBeenCalledWith(
			"/repo",
			["src/main.cpp"],
			["src/main.cpp"],
			undefined,
		);
	});
});

describe("resolveCallSites — companion source file lookup", () => {
	it("resolves call via companion .cpp when header has only a decl and another live def makes repo-wide ambiguous", () => {
		const fns: FunctionNode[] = [
			{
				qualifiedName: "helper",
				file: "src/utils.h",
				exported: true,
				isDefaultExport: false,
				line: 1,
				isDeclarationOnly: true,
			},
			{
				qualifiedName: "helper",
				file: "src/utils.cpp",
				exported: true,
				isDefaultExport: false,
				line: 5,
				isDeclarationOnly: false,
			},
			// second live def in unrelated file makes repo-wide fallback ambiguous
			{
				qualifiedName: "helper",
				file: "src/other.cpp",
				exported: true,
				isDefaultExport: false,
				line: 10,
				isDeclarationOnly: false,
			},
		];
		const calls: RawCallSite[] = [
			{
				callerQualifiedName: "main",
				callerFile: "src/main.cpp",
				rawCallee: "helper",
				kind: "call",
			},
		];
		const includesByFile = new Map([
			["src/main.cpp", [{ from: "src/main.cpp", to: "src/utils.h" }]],
		]);
		const edges = resolveCallSites(calls, fns, new Map(), includesByFile);
		expect(edges).toContainEqual({
			from: "src/main.cpp::main",
			to: "src/utils.cpp::helper",
			kind: "call",
		});
	});
});

describe("resolveCallSites — repo-wide fallback guards", () => {
	it("does not resolve C/C++ call to a unique TypeScript function", () => {
		const fns: FunctionNode[] = [
			{
				qualifiedName: "helper",
				file: "src/utils.ts",
				exported: true,
				isDefaultExport: false,
				line: 1,
			},
		];
		const calls: RawCallSite[] = [
			{
				callerQualifiedName: "main",
				callerFile: "src/main.cpp",
				rawCallee: "helper",
				kind: "call",
			},
		];
		const edges = resolveCallSites(calls, fns, new Map(), new Map());
		expect(edges).toContainEqual(expect.objectContaining({ to: "::helper" }));
		expect(edges).not.toContainEqual(
			expect.objectContaining({ to: "src/utils.ts::helper" }),
		);
	});

	it("does not resolve C/C++ call to a static (non-exported) function in another translation unit", () => {
		const fns: FunctionNode[] = [
			{
				qualifiedName: "helper",
				file: "src/other.cpp",
				exported: false,
				isDefaultExport: false,
				line: 1,
				isDeclarationOnly: false,
			},
		];
		const calls: RawCallSite[] = [
			{
				callerQualifiedName: "main",
				callerFile: "src/main.cpp",
				rawCallee: "helper",
				kind: "call",
			},
		];
		const edges = resolveCallSites(calls, fns, new Map(), new Map());
		expect(edges).toContainEqual(expect.objectContaining({ to: "::helper" }));
		expect(edges).not.toContainEqual(
			expect.objectContaining({ to: "src/other.cpp::helper" }),
		);
	});
});

describe("resolveCallSites — include lookup gated to cfamily only", () => {
	it("does not use includesByFile for a TS caller that lacks a binding", () => {
		const fns: FunctionNode[] = [
			{
				qualifiedName: "helper",
				file: "src/b.ts",
				exported: true,
				isDefaultExport: false,
				line: 1,
			},
		];
		const calls: RawCallSite[] = [
			{
				callerQualifiedName: "main",
				callerFile: "src/a.ts",
				rawCallee: "helper",
				kind: "call",
			},
		];
		// TS import edge exists, but no binding was extracted (e.g. side-effect import)
		const includesByFile = new Map([
			["src/a.ts", [{ from: "src/a.ts", to: "src/b.ts" }]],
		]);
		const edges = resolveCallSites(calls, fns, new Map(), includesByFile);
		// Must NOT resolve via include — TS callers use binding resolution only
		expect(edges).toContainEqual(expect.objectContaining({ to: "::helper" }));
		expect(edges).not.toContainEqual(
			expect.objectContaining({ to: "src/b.ts::helper" }),
		);
	});
});

describe("resolveCallSites — include lookup requires exported", () => {
	it("does not resolve to a static function in an included header", () => {
		const fns: FunctionNode[] = [
			// static inline in header — exported: false
			{
				qualifiedName: "staticHelper",
				file: "src/utils.h",
				exported: false,
				isDefaultExport: false,
				line: 1,
				isDeclarationOnly: false,
			},
		];
		const calls: RawCallSite[] = [
			{
				callerQualifiedName: "main",
				callerFile: "src/main.cpp",
				rawCallee: "staticHelper",
				kind: "call",
			},
		];
		const includesByFile = new Map([
			["src/main.cpp", [{ from: "src/main.cpp", to: "src/utils.h" }]],
		]);
		const edges = resolveCallSites(calls, fns, new Map(), includesByFile);
		// static helper not visible outside its TU
		expect(edges).toContainEqual(
			expect.objectContaining({ to: "::staticHelper" }),
		);
		expect(edges).not.toContainEqual(
			expect.objectContaining({ to: "src/utils.h::staticHelper" }),
		);
	});

	it("does not resolve to a static function in a companion source file", () => {
		const fns: FunctionNode[] = [
			// decl in header
			{
				qualifiedName: "staticHelper",
				file: "src/utils.h",
				exported: true,
				isDefaultExport: false,
				line: 1,
				isDeclarationOnly: true,
			},
			// static definition in companion — exported: false
			{
				qualifiedName: "staticHelper",
				file: "src/utils.cpp",
				exported: false,
				isDefaultExport: false,
				line: 5,
				isDeclarationOnly: false,
			},
		];
		const calls: RawCallSite[] = [
			{
				callerQualifiedName: "main",
				callerFile: "src/main.cpp",
				rawCallee: "staticHelper",
				kind: "call",
			},
		];
		const includesByFile = new Map([
			["src/main.cpp", [{ from: "src/main.cpp", to: "src/utils.h" }]],
		]);
		const edges = resolveCallSites(calls, fns, new Map(), includesByFile);
		expect(edges).toContainEqual(
			expect.objectContaining({ to: "::staticHelper" }),
		);
		expect(edges).not.toContainEqual(
			expect.objectContaining({ to: "src/utils.cpp::staticHelper" }),
		);
	});
});

describe("resolvePythonTargetFile", () => {
	const makeNodes = (paths: string[]) => {
		const m = new Map<string, FunctionNode[]>();
		for (const p of paths) m.set(p, []);
		return m;
	};

	it("resolves via exact edge.to match (flat layout)", () => {
		const includesByFile = new Map<string, ImportEdge[]>([
			[
				"mypackage/models.py",
				[{ from: "mypackage/models.py", to: "mypackage/utils.py" }],
			],
		]);
		expect(
			resolvePythonTargetFile(
				"mypackage/utils",
				"mypackage/models.py",
				makeNodes([]),
				includesByFile,
			),
		).toBe("mypackage/utils.py");
	});

	it("resolves via endsWith match (src layout)", () => {
		const includesByFile = new Map<string, ImportEdge[]>([
			["main.py", [{ from: "main.py", to: "src/mypackage/utils.py" }]],
		]);
		expect(
			resolvePythonTargetFile(
				"mypackage/utils",
				"main.py",
				makeNodes([]),
				includesByFile,
			),
		).toBe("src/mypackage/utils.py");
	});

	it("resolves __init__.py via endsWith match", () => {
		const includesByFile = new Map<string, ImportEdge[]>([
			["main.py", [{ from: "main.py", to: "src/mypackage/sub/__init__.py" }]],
		]);
		expect(
			resolvePythonTargetFile(
				"mypackage/sub",
				"main.py",
				makeNodes([]),
				includesByFile,
			),
		).toBe("src/mypackage/sub/__init__.py");
	});

	it("falls back to direct probe when no import edge exists", () => {
		expect(
			resolvePythonTargetFile(
				"mypackage/utils",
				"main.py",
				makeNodes(["mypackage/utils.py"]),
				new Map(),
			),
		).toBe("mypackage/utils.py");
	});

	it("returns null when no match found", () => {
		expect(
			resolvePythonTargetFile("os/path", "main.py", makeNodes([]), new Map()),
		).toBeNull();
	});
});

describe("resolveCallSites — dotIndex same-file qualified lookup", () => {
	it("resolves self.method() to same-file ClassName.method via dotIndex fix", () => {
		const fns: FunctionNode[] = [
			{
				qualifiedName: "Model.save",
				file: "pkg/models.py",
				exported: true,
				isDefaultExport: false,
				line: 1,
			},
			{
				qualifiedName: "Model.finalize",
				file: "pkg/models.py",
				exported: true,
				isDefaultExport: false,
				line: 5,
			},
		];
		const rawCalls: RawCallSite[] = [
			{
				callerQualifiedName: "Model.save",
				callerFile: "pkg/models.py",
				rawCallee: "Model.finalize",
				kind: "method",
			},
		];
		const edges = resolveCallSites(rawCalls, fns, new Map(), new Map());
		expect(edges).toContainEqual({
			from: "pkg/models.py::Model.save",
			to: "pkg/models.py::Model.finalize",
			kind: "method",
		});
	});
});

describe("resolveCallSites — Python named import cross-file", () => {
	it("resolves Python named import call via resolvePythonTargetFile (flat layout)", () => {
		const fns: FunctionNode[] = [
			{
				qualifiedName: "run",
				file: "main.py",
				exported: true,
				isDefaultExport: false,
				line: 2,
			},
			{
				qualifiedName: "helper",
				file: "mypackage/utils.py",
				exported: true,
				isDefaultExport: false,
				line: 1,
			},
		];
		const rawCalls: RawCallSite[] = [
			{
				callerQualifiedName: "run",
				callerFile: "main.py",
				rawCallee: "helper",
				kind: "call",
			},
		];
		const bindings = new Map([
			[
				"main.py",
				[
					{
						localName: "helper",
						importedName: "helper",
						fromSpecifier: "mypackage/utils",
						bindingKind: "named" as const,
					},
				],
			],
		]);
		const includesByFile = new Map<string, ImportEdge[]>([
			["main.py", [{ from: "main.py", to: "mypackage/utils.py" }]],
		]);
		const edges = resolveCallSites(rawCalls, fns, bindings, includesByFile);
		expect(edges).toContainEqual({
			from: "main.py::run",
			to: "mypackage/utils.py::helper",
			kind: "call",
		});
	});
});

describe("extractCallGraph — contentMap skips file reads", () => {
	beforeEach(() => {
		vi.mocked(extractImports).mockResolvedValue([]);
	});

	it("uses content from contentMap without reading disk", async () => {
		const extractCallGraphFn = vi
			.fn()
			.mockResolvedValue({
					symbols: [],
					rawCalls: [],
					rawRefs: [],
					reexports: [],
					importBindings: [],
				});
		const mockAdapter: LanguageAdapter = {
			extensions: [".ts"],
			capabilities: {
				importExtraction: true,
				callGraph: true,
				symbolIndex: false,
			},
			symbolKinds: [],
			referenceKinds: [],
			extractImports: vi.fn().mockResolvedValue([]),
			extractCallGraph: extractCallGraphFn,
		};
		vi.mocked(adapterSupports).mockReturnValue(true);
		vi.mocked(getAdapterForFile).mockReturnValue(mockAdapter);

		const contentMap = new Map([["src/a.ts", "export function foo() {}"]]);

		await extractCallGraph("/fake", ["src/a.ts"], contentMap);

		// extractCallGraph should be called with the provided content, not disk read
		expect(extractCallGraphFn).toHaveBeenCalledWith(
			"/fake",
			"src/a.ts",
			"export function foo() {}",
		);
	});
});

describe("resolveCallSites — 3.2 member resolution (A5 steps 1 and 4)", () => {
	const R = { line: 1, column: 1, endLine: 1, endColumn: 5 };
	const sym = (file: string, qualifiedName: string, kind: SymbolNode["kind"] = "method"): SymbolNode => ({
		qualifiedName,
		name: qualifiedName.slice(qualifiedName.lastIndexOf(".") + 1),
		file,
		kind,
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: R,
		nameRange: R,
	});
	const fnOf = (s: SymbolNode): FunctionNode => ({ qualifiedName: s.qualifiedName, file: s.file, exported: true, isDefaultExport: false, line: 1 });

	it("this.open() inside a namespaced class resolves to N.C.open, not N.open", () => {
		const symbols = [sym("a.ts", "N.C", "class"), sym("a.ts", "N.C.open"), sym("a.ts", "N.C.run"), sym("a.ts", "N.open", "function")];
		const raw: RawCallSite[] = [{ callerQualifiedName: "N.C.run", callerFile: "a.ts", rawCallee: "this.open", kind: "method", enclosingClass: "N.C" }];
		const edges = resolveCallSites(raw, symbols.map(fnOf), new Map(), new Map(), symbols, []);
		expect(edges).toEqual([{ from: "a.ts::N.C.run", to: "a.ts::N.C.open", kind: "method" }]);
	});

	it("python self.save() resolves through enclosingClass without adapter rewriting", () => {
		const symbols = [sym("m.py", "Model", "class"), sym("m.py", "Model.save"), sym("m.py", "Model.run")];
		const raw: RawCallSite[] = [{ callerQualifiedName: "Model.run", callerFile: "m.py", rawCallee: "self.save", kind: "method", enclosingClass: "Model" }];
		const edges = resolveCallSites(raw, symbols.map(fnOf), new Map(), new Map(), symbols, []);
		expect(edges[0].to).toBe("m.py::Model.save");
	});

	it("Foo.bar() on an imported class resolves to the static member (step 4)", () => {
		const symbols = [sym("x.ts", "Foo", "class"), sym("x.ts", "Foo.bar"), sym("a.ts", "main", "function")];
		const raw: RawCallSite[] = [{ callerQualifiedName: "main", callerFile: "a.ts", rawCallee: "Foo.bar", kind: "method" }];
		const bindings = new Map([["a.ts", [{ localName: "Foo", importedName: "Foo", fromSpecifier: "./x", bindingKind: "named" as const }]]]);
		const edges = resolveCallSites(raw, symbols.map(fnOf), bindings, new Map(), symbols, []);
		expect(edges[0].to).toBe("x.ts::Foo.bar");
	});

	it("aliased re-export is followed one hop for a bare call", () => {
		const symbols = [sym("c.ts", "foo", "function"), sym("a.ts", "main", "function")];
		const raw: RawCallSite[] = [{ callerQualifiedName: "main", callerFile: "a.ts", rawCallee: "bar", kind: "call" }];
		const bindings = new Map([["a.ts", [{ localName: "bar", importedName: "bar", fromSpecifier: "./b", bindingKind: "named" as const }]]]);
		const edges = resolveCallSites(raw, symbols.map(fnOf), bindings, new Map(), symbols, [{ file: "b.ts", exportedName: "bar", sourceName: "foo", specifier: "./c" }]);
		expect(edges[0].to).toBe("c.ts::foo");
	});

	it("inherited this.m() still falls back to ::m", () => {
		const symbols = [sym("a.ts", "Base.m"), sym("a.ts", "Sub", "class"), sym("a.ts", "Sub.run")];
		const raw: RawCallSite[] = [{ callerQualifiedName: "Sub.run", callerFile: "a.ts", rawCallee: "this.m", kind: "method", enclosingClass: "Sub" }];
		const edges = resolveCallSites(raw, symbols.map(fnOf), new Map(), new Map(), symbols, []);
		expect(edges[0].to).toBe("::m");
	});

	it("with no symbols passed, behavior is unchanged (legacy four-argument call)", () => {
		const raw: RawCallSite[] = [{ callerQualifiedName: "foo", callerFile: "src/a.ts", rawCallee: "this.x", kind: "method" }];
		const functions: FunctionNode[] = [{ qualifiedName: "foo", file: "src/a.ts", exported: true, isDefaultExport: false, line: 1 }];
		const edges = resolveCallSites(raw, functions, new Map(), new Map());
		expect(edges[0].to).toBe("::x");
	});
});

describe("resolveCallSites — C-family dotted callee include lookup", () => {
	const decl = (file: string, qualifiedName: string, isDeclarationOnly: boolean): FunctionNode => ({
		qualifiedName,
		file,
		exported: true,
		isDefaultExport: false,
		line: 1,
		isDeclarationOnly,
	});
	const site = (rawCallee: string): RawCallSite => ({ callerQualifiedName: "main", callerFile: "src/main.cpp", rawCallee, kind: "call" });
	const includes = new Map([["src/main.cpp", [{ from: "src/main.cpp", to: "src/util.h" }]]]);

	it("resolves ns.add through the included header's companion source", () => {
		const fns = [decl("src/util.h", "ns.add", true), decl("src/util.cpp", "ns.add", false), decl("src/main.cpp", "main", false)];
		const edges = resolveCallSites([site("ns.add")], fns, new Map(), includes);
		expect(edges).toEqual([{ from: "src/main.cpp::main", to: "src/util.cpp::ns.add", kind: "call" }]);
	});

	it("resolves ns.add to a live definition in the included header itself", () => {
		const fns = [decl("src/util.h", "ns.add", false), decl("src/main.cpp", "main", false)];
		const edges = resolveCallSites([site("ns.add")], fns, new Map(), includes);
		expect(edges[0].to).toBe("src/util.h::ns.add");
	});

	it("leaves ns.add unresolved (::add) when nothing included defines it", () => {
		const fns = [decl("src/other.cpp", "ns.add", false), decl("src/other2.cpp", "ns.add", false), decl("src/main.cpp", "main", false)];
		const edges = resolveCallSites([site("ns.add")], fns, new Map(), includes);
		expect(edges[0].to).toBe("::add");
	});
});

describe("extractCallGraph — refs", () => {
	it("returns resolved refs alongside calls", async () => {
		const R = { line: 2, column: 3, endLine: 2, endColumn: 6 };
		const adapter: LanguageAdapter = {
			extensions: [".ts"],
			capabilities: { importExtraction: true, callGraph: true, symbolIndex: true },
			symbolKinds: ["function"],
			referenceKinds: ["call"],
			async extractImports() { return []; },
			async extractCallGraph(_w, file) {
				return {
					symbols: [{ qualifiedName: "foo", name: "foo", file, kind: "function", exported: true, isDefaultExport: false, isDeclarationOnly: false, range: R, nameRange: R }],
					rawCalls: [],
					rawRefs: [{ file, name: "foo", kind: "call", range: R }],
					reexports: [],
					importBindings: [],
				};
			},
		};
		vi.mocked(getAdapterForFile).mockReturnValue(adapter);
		vi.mocked(adapterSupports).mockReturnValue(true);
		vi.mocked(extractImports).mockResolvedValue([]);
		const r = await extractCallGraph("/repo", ["src/a.ts"]);
		expect(r.refs).toEqual([{ file: "src/a.ts", name: "foo", kind: "call", range: R, to: "src/a.ts::foo" }]);
	});
});
