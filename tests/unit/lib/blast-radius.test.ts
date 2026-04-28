import { describe, expect, it } from "vitest";
import { queryBlastRadius } from "../../../src/lib/blast-radius.js";
import type { CallEdge, FunctionNode } from "../../../src/lib/models.js";

const functions: FunctionNode[] = [
	{ qualifiedName: "main", file: "src/cli.ts", exported: true, isDefaultExport: false, line: 1 },
	{ qualifiedName: "suggestRepo", file: "src/suggest.ts", exported: true, isDefaultExport: false, line: 1 },
	{ qualifiedName: "rankFiles", file: "src/ranker.ts", exported: true, isDefaultExport: false, line: 1 },
	{ qualifiedName: "scoreItem", file: "src/ranker.ts", exported: false, isDefaultExport: false, line: 10 },
	{ qualifiedName: "Ranker.score", file: "src/ranker.ts", exported: true, isDefaultExport: false, line: 20 },
];

const calls: CallEdge[] = [
	{ from: "src/cli.ts::main", to: "src/suggest.ts::suggestRepo", kind: "call" },
	{ from: "src/suggest.ts::suggestRepo", to: "src/ranker.ts::rankFiles", kind: "call" },
	{ from: "src/ranker.ts::rankFiles", to: "src/ranker.ts::scoreItem", kind: "call" },
];

describe("queryBlastRadius", () => {
	it("returns direct callers at hop 1", () => {
		const result = queryBlastRadius({ qualifiedName: "rankFiles", file: "src/ranker.ts" }, calls, functions);
		expect(result.tiers[0]?.hop).toBe(1);
		expect(result.tiers[0]?.hits).toContainEqual(expect.objectContaining({ qualifiedName: "suggestRepo", file: "src/suggest.ts", hop: 1 }));
	});

	it("returns transitive callers at hop 2+", () => {
		const result = queryBlastRadius({ qualifiedName: "rankFiles", file: "src/ranker.ts" }, calls, functions);
		expect(result.tiers).toHaveLength(2);
		expect(result.tiers[1]?.hop).toBe(2);
		expect(result.tiers[1]?.hits).toContainEqual(expect.objectContaining({ qualifiedName: "main", hop: 2 }));
	});

	it("reports totalAffected count", () => {
		const result = queryBlastRadius({ qualifiedName: "rankFiles", file: "src/ranker.ts" }, calls, functions);
		expect(result.totalAffected).toBe(2);
	});

	it("reports exported status from FunctionNode", () => {
		const result = queryBlastRadius({ qualifiedName: "scoreItem", file: "src/ranker.ts" }, calls, functions);
		expect(result.tiers[0]?.hits[0]).toMatchObject({ qualifiedName: "rankFiles", exported: true });
	});

	it("respects maxHops", () => {
		const result = queryBlastRadius({ qualifiedName: "rankFiles", file: "src/ranker.ts" }, calls, functions, { maxHops: 1 });
		expect(result.tiers).toHaveLength(1);
		expect(result.totalAffected).toBe(1);
	});

	it("returns empty tiers for function with no callers", () => {
		const result = queryBlastRadius({ qualifiedName: "main", file: "src/cli.ts" }, calls, functions);
		expect(result.tiers).toHaveLength(0);
		expect(result.totalAffected).toBe(0);
	});

	it("handles circular calls without infinite loop", () => {
		const circularCalls: CallEdge[] = [
			{ from: "src/a.ts::foo", to: "src/b.ts::bar", kind: "call" },
			{ from: "src/b.ts::bar", to: "src/a.ts::foo", kind: "call" },
		];
		const circularFuncs: FunctionNode[] = [
			{ qualifiedName: "foo", file: "src/a.ts", exported: true, isDefaultExport: false, line: 1 },
			{ qualifiedName: "bar", file: "src/b.ts", exported: true, isDefaultExport: false, line: 1 },
		];
		const result = queryBlastRadius({ qualifiedName: "foo", file: "src/a.ts" }, circularCalls, circularFuncs);
		expect(result.totalAffected).toBe(1);
	});

	it("deduplicates — keeps lowest hop when reached via multiple paths", () => {
		const multiPathCalls: CallEdge[] = [
			{ from: "src/a.ts::a", to: "src/target.ts::t", kind: "call" },
			{ from: "src/b.ts::b", to: "src/target.ts::t", kind: "call" },
			{ from: "src/a.ts::a", to: "src/b.ts::b", kind: "call" },
		];
		const multiPathFuncs: FunctionNode[] = [
			{ qualifiedName: "t", file: "src/target.ts", exported: true, isDefaultExport: false, line: 1 },
			{ qualifiedName: "a", file: "src/a.ts", exported: true, isDefaultExport: false, line: 1 },
			{ qualifiedName: "b", file: "src/b.ts", exported: true, isDefaultExport: false, line: 1 },
		];
		const result = queryBlastRadius({ qualifiedName: "t", file: "src/target.ts" }, multiPathCalls, multiPathFuncs);
		const hop1 = result.tiers.find((t) => t.hop === 1);
		expect(hop1?.hits).toHaveLength(2);
	});

	it("reports confidence full when no unresolved edges match target", () => {
		const result = queryBlastRadius({ qualifiedName: "rankFiles", file: "src/ranker.ts" }, calls, functions);
		expect(result.confidence).toBe("full");
		expect(result.unresolvedEdges).toBe(0);
	});

	it("reports confidence partial when unresolved edges match target name", () => {
		const callsWithUnresolved: CallEdge[] = [...calls, { from: "src/other.ts::something", to: "::rankFiles", kind: "call" }];
		const result = queryBlastRadius({ qualifiedName: "rankFiles", file: "src/ranker.ts" }, callsWithUnresolved, functions);
		expect(result.confidence).toBe("partial");
		expect(result.unresolvedEdges).toBe(1);
	});

	it("matches unresolved ::method against Class.method target on method portion", () => {
		const callsWithUnresolved: CallEdge[] = [...calls, { from: "src/other.ts::something", to: "::score", kind: "method" }];
		const result = queryBlastRadius({ qualifiedName: "Ranker.score", file: "src/ranker.ts" }, callsWithUnresolved, functions);
		expect(result.confidence).toBe("partial");
		expect(result.unresolvedEdges).toBe(1);
	});

	it("populates target.exported from FunctionNode", () => {
		const result = queryBlastRadius({ qualifiedName: "rankFiles", file: "src/ranker.ts" }, calls, functions);
		expect(result.target.exported).toBe(true);
	});
});

describe("queryBlastRadius — overload aggregation", () => {
	it("aggregates callers across overloads sharing (qualifiedName, file)", () => {
		const fns: FunctionNode[] = [
			{ qualifiedName: "Foo::bar", file: "x.cpp", exported: true, isDefaultExport: false, line: 10 },
			{ qualifiedName: "Foo::bar", file: "x.cpp", exported: true, isDefaultExport: false, line: 20 },
			{ qualifiedName: "callerA", file: "a.cpp", exported: true, isDefaultExport: false, line: 1 },
			{ qualifiedName: "callerB", file: "b.cpp", exported: true, isDefaultExport: false, line: 1 },
		];
		const calls: CallEdge[] = [
			{ from: "a.cpp::callerA", to: "x.cpp::Foo::bar", kind: "call" },
			{ from: "b.cpp::callerB", to: "x.cpp::Foo::bar", kind: "call" },
		];
		const result = queryBlastRadius(
			{ qualifiedName: "Foo::bar", file: "x.cpp" },
			calls,
			fns,
		);
		expect(result.overloadCount).toBe(2);
		expect(result.totalAffected).toBeGreaterThanOrEqual(2);
		const allHits = result.tiers.flatMap((t) => t.hits.map((h) => h.qualifiedName));
		expect(allHits).toContain("callerA");
		expect(allHits).toContain("callerB");
	});

	it("omits overloadCount when target identity is unambiguous", () => {
		const fns: FunctionNode[] = [
			{ qualifiedName: "foo", file: "x.ts", exported: true, isDefaultExport: false, line: 1 },
		];
		const result = queryBlastRadius(
			{ qualifiedName: "foo", file: "x.ts" },
			[],
			fns,
		);
		expect(result.overloadCount === undefined || result.overloadCount === 1).toBe(true);
	});
});
