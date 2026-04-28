// tests/unit/lib/call-graph.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("node:fs");
vi.mock("../../../src/lib/adapters/index.js");

import fs from "node:fs";
import { adapterForFile } from "../../../src/lib/adapters/index.js";
import type { LangAdapter, RawCallSite, ImportBinding } from "../../../src/lib/lang-adapter.js";
import type { FunctionNode } from "../../../src/lib/models.js";
import { resolveCallSites, extractCallGraph } from "../../../src/lib/call-graph.js";

describe("resolveCallSites", () => {
	const functions: FunctionNode[] = [
		{ qualifiedName: "foo", file: "src/a.ts", exported: true, isDefaultExport: false, line: 1 },
		{ qualifiedName: "bar", file: "src/b.ts", exported: true, isDefaultExport: false, line: 1 },
		{ qualifiedName: "Svc.run", file: "src/b.ts", exported: true, isDefaultExport: false, line: 5 },
		{ qualifiedName: "doThing", file: "src/c.ts", exported: true, isDefaultExport: true, line: 1 },
	];

	it("resolves same-file call", () => {
		const funcsWithHelper = [
			...functions,
			{ qualifiedName: "helper", file: "src/a.ts", exported: false, isDefaultExport: false, line: 10 },
		];
		const rawCallsFixed: RawCallSite[] = [{
			callerQualifiedName: "foo",
			callerFile: "src/a.ts",
			rawCallee: "helper",
			kind: "call",
		}];
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
		const rawCalls: RawCallSite[] = [{
			callerQualifiedName: "foo",
			callerFile: "src/a.ts",
			rawCallee: "bar",
			kind: "call",
		}];
		const bindings = new Map<string, ImportBinding[]>([
			["src/a.ts", [{
				localName: "bar",
				importedName: "bar",
				fromSpecifier: "./b",
				bindingKind: "named",
			}]],
		]);
		const edges = resolveCallSites(rawCalls, functions, bindings, new Map());
		expect(edges).toContainEqual({
			from: "src/a.ts::foo",
			to: "src/b.ts::bar",
			kind: "call",
		});
	});

	it("resolves aliased import binding", () => {
		const rawCalls: RawCallSite[] = [{
			callerQualifiedName: "foo",
			callerFile: "src/a.ts",
			rawCallee: "myBar",
			kind: "call",
		}];
		const bindings = new Map<string, ImportBinding[]>([
			["src/a.ts", [{
				localName: "myBar",
				importedName: "bar",
				fromSpecifier: "./b",
				bindingKind: "named",
			}]],
		]);
		const edges = resolveCallSites(rawCalls, functions, bindings, new Map());
		expect(edges).toContainEqual({
			from: "src/a.ts::foo",
			to: "src/b.ts::bar",
			kind: "call",
		});
	});

	it("resolves default import to named default export", () => {
		const rawCalls: RawCallSite[] = [{
			callerQualifiedName: "foo",
			callerFile: "src/a.ts",
			rawCallee: "Thing",
			kind: "call",
		}];
		const bindings = new Map<string, ImportBinding[]>([
			["src/a.ts", [{
				localName: "Thing",
				importedName: "default",
				fromSpecifier: "./c",
				bindingKind: "default",
			}]],
		]);
		const edges = resolveCallSites(rawCalls, functions, bindings, new Map());
		expect(edges).toContainEqual({
			from: "src/a.ts::foo",
			to: "src/c.ts::doThing",
			kind: "call",
		});
	});

	it("resolves namespace import member access", () => {
		const rawCalls: RawCallSite[] = [{
			callerQualifiedName: "foo",
			callerFile: "src/a.ts",
			rawCallee: "b.bar",
			kind: "method",
		}];
		const bindings = new Map<string, ImportBinding[]>([
			["src/a.ts", [{
				localName: "b",
				importedName: "*",
				fromSpecifier: "./b",
				bindingKind: "namespace",
			}]],
		]);
		const edges = resolveCallSites(rawCalls, functions, bindings, new Map());
		expect(edges).toContainEqual({
			from: "src/a.ts::foo",
			to: "src/b.ts::bar",
			kind: "method",
		});
	});

	it("falls back to ::bareMethod for unresolvable method call", () => {
		const rawCalls: RawCallSite[] = [{
			callerQualifiedName: "foo",
			callerFile: "src/a.ts",
			rawCallee: "obj.unknown",
			kind: "method",
		}];
		const edges = resolveCallSites(rawCalls, functions, new Map(), new Map());
		expect(edges).toContainEqual({
			from: "src/a.ts::foo",
			to: "::unknown",
			kind: "method",
		});
	});

	it("falls back to ::rawCallee for unresolvable plain call", () => {
		const rawCalls: RawCallSite[] = [{
			callerQualifiedName: "foo",
			callerFile: "src/a.ts",
			rawCallee: "mystery",
			kind: "call",
		}];
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
			{ qualifiedName: "foo", file: "x.cpp", exported: true, isDefaultExport: false, line: 1 },
			{ qualifiedName: "foo", file: "x.cpp", exported: true, isDefaultExport: false, line: 5 },
		];
		const calls: RawCallSite[] = [
			{ callerQualifiedName: "main", callerFile: "x.cpp", rawCallee: "foo", kind: "call" },
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
			{ qualifiedName: "foo", file: "x.ts", exported: true, isDefaultExport: false, line: 1 },
		];
		const calls: RawCallSite[] = [
			{ callerQualifiedName: "main", callerFile: "x.ts", rawCallee: "foo", kind: "call" },
		];
		const edges = resolveCallSites(
			calls,
			fns,
			new Map<string, ImportBinding[]>(),
			new Map(),
		);
		expect(edges).toEqual([{ from: "x.ts::main", to: "x.ts::foo", kind: "call" }]);
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
			{ qualifiedName: "helper", file: "src/utils.h", exported: true, isDefaultExport: false, line: 1, isDeclarationOnly: false },
		];
		const calls: RawCallSite[] = [
			{ callerQualifiedName: "main", callerFile: "src/main.cpp", rawCallee: "helper", kind: "call" },
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
			{ qualifiedName: "helper", file: "src/utils.h", exported: true, isDefaultExport: false, line: 1, isDeclarationOnly: true },
		];
		const calls: RawCallSite[] = [
			{ callerQualifiedName: "main", callerFile: "src/main.cpp", rawCallee: "helper", kind: "call" },
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
			{ qualifiedName: "helper", file: "src/other.h", exported: true, isDefaultExport: false, line: 1, isDeclarationOnly: false },
			{ qualifiedName: "helper", file: "src/utils.h", exported: true, isDefaultExport: false, line: 1, isDeclarationOnly: false },
		];
		const calls: RawCallSite[] = [
			{ callerQualifiedName: "main", callerFile: "src/main.cpp", rawCallee: "helper", kind: "call" },
		];
		const includesByFile = new Map([
			["src/main.cpp", [
				{ from: "src/main.cpp", to: "src/other.h" },
				{ from: "src/main.cpp", to: "src/utils.h" },
			]],
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
			{ qualifiedName: "helper", file: "src/utils.h", exported: true, isDefaultExport: false, line: 1, isDeclarationOnly: false },
		];
		const calls: RawCallSite[] = [
			{ callerQualifiedName: "main", callerFile: "src/main.cpp", rawCallee: "helper", kind: "call" },
		];
		const includesByFile = new Map([
			["src/main.cpp", [
				{ from: "src/main.cpp", to: "src/unrelated.h" }, // no helper here
				{ from: "src/main.cpp", to: "src/utils.h" },    // helper is here
			]],
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
      { qualifiedName: "helper", file: "src/utils.cpp", exported: true, isDefaultExport: false, line: 5, isDeclarationOnly: false },
      // also a header decl — should be filtered
      { qualifiedName: "helper", file: "src/utils.h", exported: true, isDefaultExport: false, line: 1, isDeclarationOnly: true },
    ];
    const calls: RawCallSite[] = [
      { callerQualifiedName: "main", callerFile: "src/main.cpp", rawCallee: "helper", kind: "call" },
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
      { qualifiedName: "helper", file: "src/utils1.cpp", exported: true, isDefaultExport: false, line: 5, isDeclarationOnly: false },
      { qualifiedName: "helper", file: "src/utils2.cpp", exported: true, isDefaultExport: false, line: 5, isDeclarationOnly: false },
    ];
    const calls: RawCallSite[] = [
      { callerQualifiedName: "main", callerFile: "src/main.cpp", rawCallee: "helper", kind: "call" },
    ];
    const edges = resolveCallSites(calls, fns, new Map(), new Map());
    expect(edges).toContainEqual(
      expect.objectContaining({ to: "::helper" }),
    );
  });

  it("does NOT apply repo-wide fallback for TS callers", () => {
    const fns: FunctionNode[] = [
      { qualifiedName: "helper", file: "src/utils.ts", exported: true, isDefaultExport: false, line: 5 },
    ];
    const calls: RawCallSite[] = [
      { callerQualifiedName: "main", callerFile: "src/main.ts", rawCallee: "helper", kind: "call" },
    ];
    // No bindings, no same-file match (different files)
    const edges = resolveCallSites(calls, fns, new Map(), new Map());
    // TS caller with no binding → fallback to ::helper (NOT resolved to utils.ts::helper)
    expect(edges).toContainEqual(
      expect.objectContaining({ to: "::helper" }),
    );
  });
});

describe("resolveCallSites — decl-only never becomes a call edge target", () => {
	it("header prototype is in functions[] but call resolves to the definition", () => {
		const fns: FunctionNode[] = [
			// Header declaration
			{ qualifiedName: "add", file: "src/utils.h", exported: true, isDefaultExport: false, line: 1, isDeclarationOnly: true },
			// Live definition
			{ qualifiedName: "add", file: "src/utils.cpp", exported: true, isDefaultExport: false, line: 3, isDeclarationOnly: false },
		];
		const calls: RawCallSite[] = [
			{ callerQualifiedName: "main", callerFile: "src/main.cpp", rawCallee: "add", kind: "call" },
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

	it("decl-only appears in functions[] output from extractFile", async () => {
		// This tests the extractFile path: header decl shows up in functions list
		const { createCppAdapter } = await import("../../../src/lib/adapters/cfamily.js");
		const cppAdapter = await createCppAdapter();
		const r = cppAdapter.extractFile(
			"int add(int a, int b);",   // declaration only
			"src/utils.h",
		);
		const decl = r.functions.find((f) => f.qualifiedName === "add");
		expect(decl).toBeDefined();
		expect(decl?.isDeclarationOnly).toBe(true);
	});
});

describe("extractCallGraph", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("skips files with no adapter", async () => {
		vi.mocked(adapterForFile).mockReturnValue(undefined);
		const result = await extractCallGraph("/repo", ["src/styles.css"]);
		expect(result.calls).toHaveLength(0);
		expect(result.functions).toHaveLength(0);
	});

	it("collects functions and resolved calls from adapter", async () => {
		vi.mocked(fs.readFileSync).mockReturnValue("export function main() {}");
		const mockAdapter: LangAdapter = {
			extensions: [".ts"],
			extractFile: vi.fn().mockReturnValue({
				functions: [
					{ qualifiedName: "main", file: "src/main.ts", exported: true, isDefaultExport: false, line: 1 },
					{ qualifiedName: "helper", file: "src/main.ts", exported: false, isDefaultExport: false, line: 5 },
				],
				rawCalls: [{
					callerQualifiedName: "main",
					callerFile: "src/main.ts",
					rawCallee: "helper",
					kind: "call",
				}],
				importBindings: [],
			}),
			extractImportSites: vi.fn().mockReturnValue([]),
		};
		vi.mocked(adapterForFile).mockReturnValue(mockAdapter);

		const result = await extractCallGraph("/repo", ["src/main.ts"]);
		expect(result.functions).toHaveLength(2);
		expect(result.calls).toContainEqual({
			from: "src/main.ts::main",
			to: "src/main.ts::helper",
			kind: "call",
		});
	});
});
