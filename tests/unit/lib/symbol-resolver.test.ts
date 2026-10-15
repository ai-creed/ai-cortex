// tests/unit/lib/symbol-resolver.test.ts
import { describe, expect, it } from "vitest";
import {
	buildCFamilyFunctionIndex,
	buildReexportTable,
	buildSymbolIndex,
	findTargetFile,
	resolveCFamilyFallback,
	resolveName,
	resolveRefs,
} from "../../../src/lib/symbol-resolver.js";
import type {
	ImportBinding,
	RawRefSite,
} from "../../../src/lib/lang-adapter.js";
import type { SymbolNode } from "../../../src/lib/models.js";
import { functionsFromSymbols } from "../../../src/lib/symbols.js";

const R = { line: 1, column: 1, endLine: 1, endColumn: 5 };
function sym(
	file: string,
	qualifiedName: string,
	over: Partial<SymbolNode> = {},
): SymbolNode {
	const name = qualifiedName.includes(".")
		? qualifiedName.slice(qualifiedName.lastIndexOf(".") + 1)
		: qualifiedName;
	return {
		qualifiedName,
		name,
		file,
		kind: "function",
		exported: true,
		isDefaultExport: false,
		isDeclarationOnly: false,
		range: R,
		nameRange: R,
		...over,
	};
}
const named = (
	localName: string,
	importedName: string,
	fromSpecifier: string,
): ImportBinding => ({
	localName,
	importedName,
	fromSpecifier,
	bindingKind: "named",
});
const noIncludes = new Map();
const noReexports = buildReexportTable([]);

describe("resolveName (A5)", () => {
	it("step 1: this.m inside class resolves to enclosingClass.m, including namespaced classes", () => {
		const idx = buildSymbolIndex([
			sym("a.ts", "N.C", { kind: "class" }),
			sym("a.ts", "N.C.open", { kind: "method" }),
			sym("a.ts", "N.open"),
		]);
		expect(
			resolveName(
				idx,
				{ file: "a.ts", name: "open", receiver: "this", enclosingClass: "N.C" },
				[],
				noReexports,
				noIncludes,
			),
		).toBe("a.ts::N.C.open");
		expect(
			resolveName(
				idx,
				{ file: "a.ts", name: "open", receiver: "self", enclosingClass: "N.C" },
				[],
				noReexports,
				noIncludes,
			),
		).toBe("a.ts::N.C.open");
		expect(
			resolveName(
				idx,
				{ file: "a.ts", name: "open", receiver: "N.C", enclosingClass: "N.C" },
				[],
				noReexports,
				noIncludes,
			),
		).toBe("a.ts::N.C.open");
		expect(
			resolveName(
				idx,
				{ file: "a.ts", name: "open", receiver: "C", enclosingClass: "N.C" },
				[],
				noReexports,
				noIncludes,
			),
		).toBe("a.ts::N.C.open");
	});

	it("step 1: inherited member falls through to unresolved", () => {
		const idx = buildSymbolIndex([
			sym("a.ts", "Base.m", { kind: "method" }),
			sym("a.ts", "Sub", { kind: "class" }),
		]);
		expect(
			resolveName(
				idx,
				{ file: "a.ts", name: "m", receiver: "this", enclosingClass: "Sub" },
				[],
				noReexports,
				noIncludes,
			),
		).toBeNull();
	});

	it("step 2: same-file bare match; ambiguity across keys stays unresolved; overload rows sharing a key resolve", () => {
		const idx = buildSymbolIndex([
			sym("a.ts", "f"),
			sym("a.ts", "f", { isDeclarationOnly: true }),
			sym("a.ts", "g"),
			sym("b.ts", "g"),
		]);
		expect(
			resolveName(
				idx,
				{ file: "a.ts", name: "f" },
				[],
				noReexports,
				noIncludes,
			),
		).toBe("a.ts::f");
		expect(
			resolveName(
				idx,
				{ file: "a.ts", name: "g" },
				[],
				noReexports,
				noIncludes,
			),
		).toBe("a.ts::g");
		expect(
			resolveName(
				idx,
				{ file: "c.ts", name: "g" },
				[],
				noReexports,
				noIncludes,
			),
		).toBeNull();
	});

	it("step 3: import ref resolves directly by specifier and importKind", () => {
		const idx = buildSymbolIndex([
			sym("src/x.ts", "foo"),
			sym("src/x.ts", "Def", { isDefaultExport: true, kind: "class" }),
		]);
		expect(
			resolveName(
				idx,
				{
					file: "src/a.ts",
					name: "foo",
					specifier: "./x",
					importKind: "named",
				},
				[],
				noReexports,
				noIncludes,
			),
		).toBe("src/x.ts::foo");
		expect(
			resolveName(
				idx,
				{
					file: "src/a.ts",
					name: "Foo",
					specifier: "./x",
					importKind: "default",
				},
				[],
				noReexports,
				noIncludes,
			),
		).toBe("src/x.ts::Def");
		expect(
			resolveName(
				idx,
				{
					file: "src/a.ts",
					name: "ns",
					specifier: "./x",
					importKind: "namespace",
				},
				[],
				noReexports,
				noIncludes,
			),
		).toBeNull();
	});

	it("step 3: aliased binding resolves through importedName; namespace binding resolves member", () => {
		const idx = buildSymbolIndex([
			sym("src/x.ts", "foo"),
			sym("src/x.ts", "util"),
		]);
		const bindings = [
			named("bar", "foo", "./x"),
			{
				localName: "ns",
				importedName: "*",
				fromSpecifier: "./x",
				bindingKind: "namespace" as const,
			},
		];
		expect(
			resolveName(
				idx,
				{ file: "src/a.ts", name: "bar" },
				bindings,
				noReexports,
				noIncludes,
			),
		).toBe("src/x.ts::foo");
		expect(
			resolveName(
				idx,
				{ file: "src/a.ts", name: "util", receiver: "ns" },
				bindings,
				noReexports,
				noIncludes,
			),
		).toBe("src/x.ts::util");
	});

	it("step 3: one aliased re-export hop is followed; a second hop is not", () => {
		const idx = buildSymbolIndex([
			sym("src/c.ts", "foo"),
			sym("src/b.ts", "unrelated"),
			sym("src/a.ts", "unrelated2"),
		]);
		const table = buildReexportTable([
			{
				file: "src/b.ts",
				exportedName: "bar",
				sourceName: "foo",
				specifier: "./c",
			},
			{
				file: "src/m.ts",
				exportedName: "bar",
				sourceName: "bar",
				specifier: "./b",
			},
		]);
		expect(
			resolveName(
				idx,
				{ file: "src/a.ts", name: "bar" },
				[named("bar", "bar", "./b")],
				table,
				noIncludes,
			),
		).toBe("src/c.ts::foo");
		expect(
			resolveName(
				idx,
				{
					file: "src/a.ts",
					name: "bar",
					specifier: "./b",
					importKind: "named",
				},
				[],
				table,
				noIncludes,
			),
		).toBe("src/c.ts::foo");
		expect(
			resolveName(
				idx,
				{ file: "src/a.ts", name: "bar" },
				[named("bar", "bar", "./m")],
				table,
				noIncludes,
			),
		).toBeNull();
	});

	it("step 3: a re-export-only intermediary (no symbols of its own) is found through the import graph", () => {
		const idx = buildSymbolIndex([
			sym("src/c.ts", "foo"),
			sym("src/a.ts", "main"),
		]);
		const table = buildReexportTable([
			{
				file: "src/b.ts",
				exportedName: "bar",
				sourceName: "foo",
				specifier: "./c",
			},
		]);
		const includes = new Map([
			["src/a.ts", [{ from: "src/a.ts", to: "src/b.ts" }]],
			["src/b.ts", [{ from: "src/b.ts", to: "src/c.ts" }]],
		]);
		expect(
			resolveName(
				idx,
				{ file: "src/a.ts", name: "bar" },
				[named("bar", "bar", "./b")],
				table,
				includes,
			),
		).toBe("src/c.ts::foo");
		expect(
			resolveName(
				idx,
				{
					file: "src/a.ts",
					name: "bar",
					specifier: "./b",
					importKind: "named",
				},
				[],
				table,
				includes,
			),
		).toBe("src/c.ts::foo");
	});

	it("step 3: an export-from ref (specifier, no importKind) resolves to the source symbol", () => {
		const idx = buildSymbolIndex([sym("src/x.ts", "foo")]);
		expect(
			resolveName(
				idx,
				{ file: "src/b.ts", name: "foo", specifier: "./x" },
				[],
				noReexports,
				noIncludes,
			),
		).toBe("src/x.ts::foo");
	});

	it("step 3: the same name re-exported from two different sources is ambiguous and stays unresolved", () => {
		const idx = buildSymbolIndex([
			sym("src/c.ts", "foo"),
			sym("src/d.ts", "foo"),
			sym("src/a.ts", "main"),
		]);
		const table = buildReexportTable([
			{
				file: "src/b.ts",
				exportedName: "bar",
				sourceName: "foo",
				specifier: "./c",
			},
			{
				file: "src/b.ts",
				exportedName: "bar",
				sourceName: "foo",
				specifier: "./d",
			},
			{
				file: "src/b.ts",
				exportedName: "bar",
				sourceName: "foo",
				specifier: "./c",
			}, // exact duplicate is not ambiguity
		]);
		const includes = new Map([
			["src/a.ts", [{ from: "src/a.ts", to: "src/b.ts" }]],
			[
				"src/b.ts",
				[
					{ from: "src/b.ts", to: "src/c.ts" },
					{ from: "src/b.ts", to: "src/d.ts" },
				],
			],
		]);
		expect(
			resolveName(
				idx,
				{ file: "src/a.ts", name: "bar" },
				[named("bar", "bar", "./b")],
				table,
				includes,
			),
		).toBeNull();
		const single = buildReexportTable([
			{
				file: "src/b.ts",
				exportedName: "bar",
				sourceName: "foo",
				specifier: "./c",
			},
			{
				file: "src/b.ts",
				exportedName: "bar",
				sourceName: "foo",
				specifier: "./c",
			},
		]);
		expect(
			resolveName(
				idx,
				{ file: "src/a.ts", name: "bar" },
				[named("bar", "bar", "./b")],
				single,
				includes,
			),
		).toBe("src/c.ts::foo");
	});

	it("step 4: static member on same-file or imported class/enum/namespace", () => {
		const idx = buildSymbolIndex([
			sym("src/x.ts", "Color", { kind: "enum" }),
			sym("src/x.ts", "Color.Red", { kind: "enum_member" }),
			sym("src/a.ts", "Foo", { kind: "class" }),
			sym("src/a.ts", "Foo.bar", { kind: "method" }),
		]);
		expect(
			resolveName(
				idx,
				{ file: "src/a.ts", name: "bar", receiver: "Foo" },
				[],
				noReexports,
				noIncludes,
			),
		).toBe("src/a.ts::Foo.bar");
		expect(
			resolveName(
				idx,
				{ file: "src/a.ts", name: "Red", receiver: "Color" },
				[named("Color", "Color", "./x")],
				noReexports,
				noIncludes,
			),
		).toBe("src/x.ts::Color.Red");
	});

	it("python: specifier resolution goes through import edges with .py / __init__.py probing", () => {
		const idx = buildSymbolIndex([sym("pkg/utils.py", "helper")]);
		const includes = new Map([
			["pkg/m.py", [{ from: "pkg/m.py", to: "pkg/utils.py" }]],
		]);
		expect(
			resolveName(
				idx,
				{ file: "pkg/m.py", name: "h" },
				[named("h", "helper", "pkg/utils")],
				noReexports,
				includes,
			),
		).toBe("pkg/utils.py::helper");
	});
});

describe("resolveRefs", () => {
	it("maps RawRefSite to RefEdge with to and from keys; module-scope refs have no from", () => {
		const symbols = [
			sym("src/x.ts", "foo"),
			sym("src/a.ts", "run"),
			sym("src/a.ts", "C", { kind: "class" }),
			sym("src/a.ts", "C.m", { kind: "method" }),
		];
		const raw: RawRefSite[] = [
			{
				file: "src/a.ts",
				name: "foo",
				kind: "import",
				range: R,
				specifier: "./x",
				importKind: "named",
			},
			{
				file: "src/a.ts",
				name: "foo",
				kind: "call",
				range: R,
				enclosingQualifiedName: "run",
			},
			{
				file: "src/a.ts",
				name: "m",
				kind: "call",
				range: R,
				receiver: "this",
				enclosingQualifiedName: "C.m",
				enclosingClass: "C",
			},
			{
				file: "src/a.ts",
				name: "nothing",
				kind: "type",
				range: R,
				enclosingQualifiedName: "notASymbol",
			},
		];
		const out = resolveRefs(
			raw,
			symbols,
			new Map([["src/a.ts", [named("foo", "foo", "./x")]]]),
			[],
			new Map(),
		);
		expect(out).toEqual([
			{
				file: "src/a.ts",
				name: "foo",
				kind: "import",
				range: R,
				to: "src/x.ts::foo",
			},
			{
				file: "src/a.ts",
				name: "foo",
				kind: "call",
				range: R,
				to: "src/x.ts::foo",
				from: "src/a.ts::run",
			},
			{
				file: "src/a.ts",
				name: "m",
				kind: "call",
				range: R,
				to: "src/a.ts::C.m",
				from: "src/a.ts::C.m",
			},
			{ file: "src/a.ts", name: "nothing", kind: "type", range: R },
		]);
	});

	it("C-family: resolves an include-only name through the header's companion source, and leaves TS sites alone", () => {
		const symbols = [
			sym("src/util.h", "helper", { isDeclarationOnly: true }),
			sym("src/util.c", "helper"),
			sym("src/main.c", "main"),
			sym("src/other.ts", "helper"),
		];
		const includes = new Map([["src/main.c", [{ from: "src/main.c", to: "src/util.h" }]]]);
		const raw: RawRefSite[] = [
			{ file: "src/main.c", name: "helper", kind: "call", range: R, enclosingQualifiedName: "main" },
			{ file: "src/a.ts", name: "helper", kind: "call", range: R },
		];
		const out = resolveRefs(raw, symbols, new Map(), [], includes);
		expect(out[0]).toMatchObject({ to: "src/util.c::helper", from: "src/main.c::main" });
		expect(out[1].to).toBeUndefined();
	});
});

describe("resolveCFamilyFallback (A5 ambiguity rule)", () => {
	const includes = new Map([
		[
			"src/main.c",
			[
				{ from: "src/main.c", to: "src/a.h" },
				{ from: "src/main.c", to: "src/b.h" },
			],
		],
	]);
	const resolve = (symbols: SymbolNode[]) =>
		resolveCFamilyFallback(
			buildCFamilyFunctionIndex(functionsFromSymbols(symbols)),
			"src/main.c",
			"foo",
			includes,
		);

	it("two included headers declaring foo with no companions leave the site unresolved", () => {
		expect(
			resolve([
				sym("src/a.h", "foo", { isDeclarationOnly: true }),
				sym("src/b.h", "foo", { isDeclarationOnly: true }),
				sym("src/main.c", "main"),
			]),
		).toBeNull();
	});

	it("two included headers whose companions both define foo leave the site unresolved", () => {
		expect(
			resolve([
				sym("src/a.h", "foo", { isDeclarationOnly: true }),
				sym("src/a.c", "foo"),
				sym("src/b.h", "foo", { isDeclarationOnly: true }),
				sym("src/b.c", "foo"),
				sym("src/main.c", "main"),
			]),
		).toBeNull();
	});

	it("one header declaring foo plus its companion defining it resolves to the companion", () => {
		expect(
			resolve([
				sym("src/a.h", "foo", { isDeclarationOnly: true }),
				sym("src/a.c", "foo"),
				sym("src/b.h", "bar", { isDeclarationOnly: true }),
				sym("src/main.c", "main"),
			]),
		).toBe("src/a.c::foo");
	});

	it("a lone included declaration is not a candidate; the repo-wide step finds the single definition", () => {
		expect(
			resolve([
				sym("src/a.h", "foo", { isDeclarationOnly: true }),
				sym("src/impl/foo_impl.c", "foo"),
				sym("src/main.c", "main"),
			]),
		).toBe("src/impl/foo_impl.c::foo");
	});
});

describe("findTargetFile", () => {
	it("returns the first known file per stripped path, falls back to index, and sees files added later", () => {
		const known = new Map<string, unknown>([
			["src/a.ts", true],
			["src/a.js", true],
			["src/b/index.ts", true],
		]);
		expect(findTargetFile("src/a.js", known, "ts")).toBe("src/a.ts");
		expect(findTargetFile("src/b", known, "ts")).toBe("src/b/index.ts");
		expect(findTargetFile("src/c", known, "ts")).toBeNull();
		known.set("src/c.tsx", true);
		expect(findTargetFile("src/c", known, "ts")).toBe("src/c.tsx");
	});

	it("matches C-family includes exactly or by a unique basename", () => {
		const known = new Map<string, unknown>([
			["inc/u.h", true],
			["x/dup.h", true],
			["y/dup.h", true],
		]);
		expect(findTargetFile("inc/u.h", known, "cfamily")).toBe("inc/u.h");
		expect(findTargetFile("other/u.h", known, "cfamily")).toBe("inc/u.h");
		expect(findTargetFile("z/dup.h", known, "cfamily")).toBeNull();
	});
});
