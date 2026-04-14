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
		const edges = resolveCallSites(rawCalls, functions, bindings);
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
		const edges = resolveCallSites(rawCalls, functions, bindings);
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
		const edges = resolveCallSites(rawCalls, functions, bindings);
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
		const edges = resolveCallSites(rawCalls, functions, bindings);
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
		const edges = resolveCallSites(rawCalls, functions, new Map());
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
		const edges = resolveCallSites(rawCalls, functions, new Map());
		expect(edges).toContainEqual({
			from: "src/a.ts::foo",
			to: "::mystery",
			kind: "call",
		});
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
