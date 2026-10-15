// tests/unit/lib/adapters/typescript.test.ts
import { describe, expect, it, beforeAll } from "vitest";
import { createTypescriptAdapter } from "../../../../src/lib/adapters/typescript.js";
import { functionsFromSymbols } from "../../../../src/lib/symbols.js";
import type { LanguageAdapter } from "../../../../src/lib/lang-adapter.js";

let adapter: LanguageAdapter;

beforeAll(async () => {
	adapter = await createTypescriptAdapter();
});

describe("typescript adapter — function extraction", () => {
	it("extracts named function declaration", async () => {
		const result = await adapter.extractCallGraph!(
			"",
			"src/foo.ts",
			"function foo() { return 1; }",
		);
		expect(functionsFromSymbols(result.symbols)).toContainEqual(
			expect.objectContaining({
				qualifiedName: "foo",
				file: "src/foo.ts",
				exported: false,
				isDefaultExport: false,
			}),
		);
	});

	it("extracts exported function declaration", async () => {
		const result = await adapter.extractCallGraph!(
			"",
			"src/bar.ts",
			"export function bar() {}",
		);
		expect(functionsFromSymbols(result.symbols)).toContainEqual(
			expect.objectContaining({
				qualifiedName: "bar",
				exported: true,
				isDefaultExport: false,
			}),
		);
	});

	it("extracts arrow function assigned to const", async () => {
		const result = await adapter.extractCallGraph!(
			"",
			"src/baz.ts",
			"const baz = () => {};",
		);
		expect(functionsFromSymbols(result.symbols)).toContainEqual(
			expect.objectContaining({
				qualifiedName: "baz",
				exported: false,
			}),
		);
	});

	it("extracts exported arrow function", async () => {
		const result = await adapter.extractCallGraph!(
			"",
			"src/qux.ts",
			"export const qux = () => {};",
		);
		expect(functionsFromSymbols(result.symbols)).toContainEqual(
			expect.objectContaining({
				qualifiedName: "qux",
				exported: true,
				isDefaultExport: false,
			}),
		);
	});

	it("extracts class method with qualified name", async () => {
		const result = await adapter.extractCallGraph!(
			"",
			"src/foo.ts",
			"class Foo { bar() {} render() {} }",
		);
		expect(functionsFromSymbols(result.symbols)).toContainEqual(
			expect.objectContaining({ qualifiedName: "Foo.bar" }),
		);
		expect(functionsFromSymbols(result.symbols)).toContainEqual(
			expect.objectContaining({ qualifiedName: "Foo.render" }),
		);
	});

	it("marks methods of exported class as exported", async () => {
		const result = await adapter.extractCallGraph!(
			"",
			"src/svc.ts",
			"export class Svc { run() {} }",
		);
		expect(functionsFromSymbols(result.symbols)).toContainEqual(
			expect.objectContaining({
				qualifiedName: "Svc.run",
				exported: true,
			}),
		);
	});

	it("does not collapse same-name methods in different classes", async () => {
		const result = await adapter.extractCallGraph!(
			"",
			"src/ab.ts",
			"class A { render() {} }\nclass B { render() {} }",
		);
		const names = functionsFromSymbols(result.symbols).map((f) => f.qualifiedName);
		expect(names).toContain("A.render");
		expect(names).toContain("B.render");
	});

	it("extracts named default export function", async () => {
		const result = await adapter.extractCallGraph!(
			"",
			"src/do.ts",
			"export default function doThing() {}",
		);
		expect(functionsFromSymbols(result.symbols)).toContainEqual(
			expect.objectContaining({
				qualifiedName: "doThing",
				exported: true,
				isDefaultExport: true,
			}),
		);
	});

	it("synthesizes 'default' name for anonymous default export", async () => {
		const result = await adapter.extractCallGraph!(
			"",
			"src/anon.ts",
			"export default () => {};",
		);
		expect(functionsFromSymbols(result.symbols)).toContainEqual(
			expect.objectContaining({
				qualifiedName: "default",
				exported: true,
				isDefaultExport: true,
			}),
		);
	});

	it("extracts default-exported class with methods", async () => {
		const result = await adapter.extractCallGraph!(
			"",
			"src/ctrl.ts",
			"export default class Ctrl { handle() {} }",
		);
		expect(functionsFromSymbols(result.symbols)).toContainEqual(
			expect.objectContaining({
				qualifiedName: "Ctrl",
				isDefaultExport: true,
			}),
		);
		expect(functionsFromSymbols(result.symbols)).toContainEqual(
			expect.objectContaining({
				qualifiedName: "Ctrl.handle",
				exported: true,
			}),
		);
	});

	it("reports accurate line numbers", async () => {
		const source = "// comment\n\nfunction foo() {}\n";
		const result = await adapter.extractCallGraph!("", "src/foo.ts", source);
		const foo = functionsFromSymbols(result.symbols).find((f) => f.qualifiedName === "foo");
		expect(foo?.line).toBe(3);
	});
});

describe("typescript adapter — raw call site extraction", () => {
	it("extracts direct function call", async () => {
		const result = await adapter.extractCallGraph!(
			"",
			"src/a.ts",
			"function a() { foo(); }",
		);
		expect(result.rawCalls).toContainEqual(
			expect.objectContaining({
				rawCallee: "foo",
				kind: "call",
				callerFile: "src/a.ts",
			}),
		);
	});

	it("extracts new expression", async () => {
		const result = await adapter.extractCallGraph!(
			"",
			"src/a.ts",
			"function a() { new Foo(); }",
		);
		expect(result.rawCalls).toContainEqual(
			expect.objectContaining({
				rawCallee: "Foo",
				kind: "new",
			}),
		);
	});

	it("extracts method call with receiver", async () => {
		const result = await adapter.extractCallGraph!(
			"",
			"src/a.ts",
			"function a() { obj.method(); }",
		);
		expect(result.rawCalls).toContainEqual(
			expect.objectContaining({
				rawCallee: "obj.method",
				kind: "method",
			}),
		);
	});

	it("extracts this.method call", async () => {
		const result = await adapter.extractCallGraph!(
			"",
			"src/foo.ts",
			"class Foo { bar() { this.baz(); } baz() {} }",
		);
		expect(result.rawCalls).toContainEqual(
			expect.objectContaining({
				rawCallee: "this.baz",
				kind: "method",
				callerQualifiedName: "Foo.bar",
			}),
		);
	});

	it("sets callerQualifiedName to enclosing function", async () => {
		const result = await adapter.extractCallGraph!(
			"",
			"src/x.ts",
			"function outer() { inner(); }\nfunction inner() {}",
		);
		const call = result.rawCalls.find((c) => c.rawCallee === "inner");
		expect(call?.callerQualifiedName).toBe("outer");
	});
});

describe("typescript adapter — import binding extraction", () => {
	it("extracts named import", async () => {
		const result = await adapter.extractCallGraph!(
			"",
			"src/a.ts",
			'import { foo } from "./bar";',
		);
		expect(result.importBindings).toContainEqual({
			localName: "foo",
			importedName: "foo",
			fromSpecifier: "./bar",
			bindingKind: "named",
		});
	});

	it("extracts aliased import", async () => {
		const result = await adapter.extractCallGraph!(
			"",
			"src/a.ts",
			'import { foo as baz } from "./bar";',
		);
		expect(result.importBindings).toContainEqual({
			localName: "baz",
			importedName: "foo",
			fromSpecifier: "./bar",
			bindingKind: "named",
		});
	});

	it("extracts default import", async () => {
		const result = await adapter.extractCallGraph!(
			"",
			"src/a.ts",
			'import Bar from "./bar";',
		);
		expect(result.importBindings).toContainEqual({
			localName: "Bar",
			importedName: "default",
			fromSpecifier: "./bar",
			bindingKind: "default",
		});
	});

	it("extracts namespace import", async () => {
		const result = await adapter.extractCallGraph!(
			"",
			"src/a.ts",
			'import * as utils from "./utils";',
		);
		expect(result.importBindings).toContainEqual({
			localName: "utils",
			importedName: "*",
			fromSpecifier: "./utils",
			bindingKind: "namespace",
		});
	});

	it("ignores non-relative imports", async () => {
		const result = await adapter.extractCallGraph!(
			"",
			"src/a.ts",
			'import { readFileSync } from "node:fs";',
		);
		expect(result.importBindings).toHaveLength(0);
	});
});

describe("typescript adapter — edge cases", () => {
	it("returns empty result for empty file", async () => {
		const result = await adapter.extractCallGraph!("", "src/empty.ts", "");
		expect(functionsFromSymbols(result.symbols)).toHaveLength(0);
		expect(result.rawCalls).toHaveLength(0);
		expect(result.importBindings).toHaveLength(0);
	});

	it("handles file with syntax errors gracefully", async () => {
		const result = await adapter.extractCallGraph!(
			"",
			"src/broken.ts",
			"function foo( { bar(); }",
		);
		// Should not throw — tree-sitter does partial parsing
		expect(result).toBeDefined();
	});
});

describe("typescript adapter — import sites", () => {
	it("emits a RawImportSite per relative import", async () => {
		const sites = await adapter.extractImports(
			"",
			"src/main.ts",
			'import x from "./foo";\nimport { y } from "../bar/baz";\nimport "external";',
		);
		expect(sites).toEqual([
			{
				from: "src/main.ts",
				rawSpecifier: "./foo",
				candidate: "src/foo",
			},
			{
				from: "src/main.ts",
				rawSpecifier: "../bar/baz",
				candidate: "bar/baz",
			},
		]);
	});

	it("ignores non-relative imports", async () => {
		const sites = await adapter.extractImports(
			"",
			"src/main.ts",
			'import { x } from "react";',
		);
		expect(sites).toEqual([]);
	});

	it("strips known TS extension from candidate for import './b.ts'", async () => {
		const sites = await adapter.extractImports(
			"",
			"src/a.ts",
			'import x from "./b.ts";',
		);
		expect(sites).toHaveLength(1);
		expect(sites[0].candidate).toBe("src/b");
		expect(sites[0].rawSpecifier).toBe("./b.ts");
	});

	it("strips .js extension from candidate for import './util.js'", async () => {
		const sites = await adapter.extractImports(
			"",
			"src/a.ts",
			'import { helper } from "./util.js";',
		);
		expect(sites).toHaveLength(1);
		expect(sites[0].candidate).toBe("src/util");
	});
});

describe("typescript adapter — range and site emission (unit)", () => {
	it("populates column/endLine/endColumn on a multi-line function", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"src/r.ts",
			"function multi() {\n  return 1;\n}",
		);
		const fn = functionsFromSymbols(r.symbols).find((f) => f.qualifiedName === "multi");
		expect(fn?.column).toBe(1);
		expect(fn?.endLine).toBeGreaterThan(fn!.line);
		expect(fn?.endColumn).toBeGreaterThanOrEqual(1);
	});

	it("populates site on a plain call expression", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"src/c.ts",
			"function caller() {\n  callee();\n}",
		);
		const call = r.rawCalls.find(
			(c) => c.rawCallee === "callee" && c.kind === "call",
		);
		expect(call?.site).toBeDefined();
		expect(call?.site?.line).toBe(2);
		expect(call?.site?.column).toBeGreaterThanOrEqual(1);
		expect(call?.site?.endColumn).toBeGreaterThanOrEqual(1);
	});

	it("populates site on a method call and a new expression", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"src/m.ts",
			"function caller() {\n  obj.method();\n  new Thing();\n}",
		);
		const method = r.rawCalls.find((c) => c.kind === "method");
		const ctor = r.rawCalls.find((c) => c.kind === "new");
		expect(method?.site).toBeDefined();
		expect(ctor?.site).toBeDefined();
	});
});

describe("typescript adapter — symbols (3.2)", () => {
	async function symbolsOf(src: string, file = "src/s.ts") {
		const r = await adapter.extractCallGraph!("", file, src);
		return r.symbols;
	}

	it("emits interface, type alias, enum, enum members, namespace, variable, property", async () => {
		const syms = await symbolsOf(
			[
				"export interface WorktreeStatus { dirty: boolean; refresh(): void }",
				"export type Id = string;",
				"export enum Color { Red, Green = 2 }",
				"export namespace Util { export const x = 1; }",
				"const answer = 42;",
				"export const { a, b: c } = obj;",
			].join("\n"),
		);
		const byQn = Object.fromEntries(syms.map((s) => [s.qualifiedName, s]));
		expect(byQn.WorktreeStatus).toMatchObject({ kind: "interface", name: "WorktreeStatus", exported: true });
		expect(byQn["WorktreeStatus.dirty"]).toMatchObject({ kind: "property", isDeclarationOnly: true, containerQualifiedName: "WorktreeStatus" });
		expect(byQn["WorktreeStatus.refresh"]).toMatchObject({ kind: "method", isDeclarationOnly: true });
		expect(byQn.Id).toMatchObject({ kind: "type", exported: true });
		expect(byQn.Color).toMatchObject({ kind: "enum" });
		expect(byQn["Color.Red"]).toMatchObject({ kind: "enum_member", name: "Red", containerQualifiedName: "Color" });
		expect(byQn["Color.Green"]).toMatchObject({ kind: "enum_member" });
		expect(byQn.Util).toMatchObject({ kind: "namespace" });
		expect(byQn["Util.x"]).toMatchObject({ kind: "variable", exported: true, containerQualifiedName: "Util" });
		expect(byQn.answer).toMatchObject({ kind: "variable", exported: false });
		expect(byQn.a).toMatchObject({ kind: "variable", exported: true });
		expect(byQn.c).toMatchObject({ kind: "variable", name: "c" });
		expect(byQn.b).toBeUndefined();
	});

	it("name range lies inside the declaration range and starts after it", async () => {
		const [iface] = await symbolsOf("export interface WorktreeStatus {\n  dirty: boolean;\n}\n");
		expect(iface.nameRange.line).toBe(iface.range.line);
		expect(iface.nameRange.column).toBeGreaterThan(iface.range.column);
		expect(iface.nameRange.column).toBe("export interface ".length + 1);
		expect(iface.nameRange.endColumn).toBe("export interface WorktreeStatus".length);
		expect(iface.range.endLine).toBe(3);
	});

	it("class members carry container and enclosing names; namespace containers join with '.'", async () => {
		const syms = await symbolsOf(
			"namespace N { export class C { x = 1; run() {} static s() {} } }",
		);
		const qns = syms.map((s) => s.qualifiedName).sort();
		expect(qns).toEqual(["N", "N.C", "N.C.run", "N.C.s", "N.C.x"]);
		const run = syms.find((s) => s.qualifiedName === "N.C.run")!;
		expect(run).toMatchObject({ kind: "method", name: "run", containerQualifiedName: "N.C", exported: true });
		for (const s of syms) expect(s.qualifiedName).not.toContain("::");
	});

	it("marks overload signatures, declare, abstract, and interface members declaration-only; implementation is not", async () => {
		const syms = await symbolsOf(
			[
				"declare function d(): void;",
				"export function o(a: string): void;",
				"export function o(a: number): void;",
				"export function o(a: unknown) {}",
				"abstract class A { abstract m(): void; n() {} }",
			].join("\n"),
		);
		const o = syms.filter((s) => s.qualifiedName === "o");
		expect(o.map((s) => s.isDeclarationOnly)).toEqual([true, true, false]);
		expect(syms.find((s) => s.qualifiedName === "d")!.isDeclarationOnly).toBe(true);
		expect(syms.find((s) => s.qualifiedName === "A.m")!.isDeclarationOnly).toBe(true);
		expect(syms.find((s) => s.qualifiedName === "A.n")!.isDeclarationOnly).toBe(false);
		expect(syms.find((s) => s.qualifiedName === "A")!.kind).toBe("class");
	});

	it("re-opened namespace yields two symbol rows with one key, functions projects classes once", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"src/s.ts",
			"namespace N { export class C {} }\nnamespace N { export const y = 1; }",
		);
		const ns = r.symbols.filter((s) => s.qualifiedName === "N");
		expect(ns).toHaveLength(2);
		expect(ns.every((s) => s.kind === "namespace")).toBe(true);
		expect(functionsFromSymbols(r.symbols).filter((f) => f.qualifiedName === "N.C")).toHaveLength(1);
	});

	it("computed and string-literal member names are unquoted", async () => {
		const syms = await symbolsOf(
			"class K { ['computed']() {} \"quoted\" = 1 }",
		);
		expect(syms.map((s) => s.name).sort()).toEqual(["K", "computed", "quoted"]);
	});

	it("anonymous default export keeps 'default' with the name range on the keyword", async () => {
		const syms = await symbolsOf("export default class {}");
		expect(syms).toHaveLength(1);
		expect(syms[0]).toMatchObject({ qualifiedName: "default", name: "default", kind: "class", isDefaultExport: true });
		expect(syms[0].nameRange).toEqual({ line: 1, column: 8, endLine: 1, endColumn: 14 });
	});

	it("does not emit function-local declarations or parameters", async () => {
		const syms = await symbolsOf(
			"export function outer(p: number) { const inner = 1; function nested() {} class Local {} return inner; }",
		);
		expect(syms.map((s) => s.qualifiedName)).toEqual(["outer"]);
	});

	it("rawCalls carry enclosingClass for this.* calls inside namespaced classes", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"src/s.ts",
			"namespace N { export class C { open() {} run() { this.open(); } } }",
		);
		const call = r.rawCalls.find((c) => c.rawCallee === "this.open")!;
		expect(call.callerQualifiedName).toBe("N.C.run");
		expect(call.enclosingClass).toBe("N.C");
	});
});

describe("typescript adapter — symbols (3.2) review fixes", () => {
	it("object-literal methods are not indexed and do not become callers", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"src/s.ts",
			"function fetch() {}\nexport default { fetch() { helper(); } };\nfoo({ m() { go(); } });",
		);
		expect(r.symbols.map((s) => s.qualifiedName)).toEqual(["fetch"]);
		expect(functionsFromSymbols(r.symbols).map((f) => f.qualifiedName)).toEqual(["fetch"]);
		expect(r.rawCalls.map((c) => c.callerQualifiedName)).not.toContain("fetch");
		expect(r.rawCalls.find((c) => c.rawCallee === "go")).toBeUndefined();
	});

	it("methods of an anonymous class expression are not indexed", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"src/s.ts",
			"export const X = mixin(class { m() { foo(); } });",
		);
		expect(r.symbols.map((s) => s.qualifiedName)).toEqual(["X"]);
		expect(r.rawCalls.find((c) => c.rawCallee === "foo")).toBeUndefined();
	});

	it("dotted namespace names get one name range per segment", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"src/s.ts",
			"namespace A.B { export function f() {} }",
		);
		const a = r.symbols.find((s) => s.qualifiedName === "A")!;
		const b = r.symbols.find((s) => s.qualifiedName === "A.B")!;
		expect(a.nameRange).toEqual({ line: 1, column: 11, endLine: 1, endColumn: 11 });
		expect(b.nameRange).toEqual({ line: 1, column: 13, endLine: 1, endColumn: 13 });
		expect(r.symbols.some((s) => s.qualifiedName === "A.B.f")).toBe(true);
	});
});

describe("typescript adapter — refs (3.2)", () => {
	async function refsOf(src: string, file = "src/r.ts") {
		const r = await adapter.extractCallGraph!("", file, src);
		return { refs: r.rawRefs, reexports: r.reexports };
	}
	const pick = (refs: import("../../../../src/lib/lang-adapter.js").RawRefSite[], kind: string) =>
		refs.filter((r) => r.kind === kind).map((r) => ({ name: r.name, receiver: r.receiver, alias: r.alias, specifier: r.specifier, importKind: r.importKind, line: r.range.line, col: r.range.column, endCol: r.range.endColumn }));

	it("import forms follow the A3 table exactly", async () => {
		const { refs, reexports } = await refsOf(
			[
				'import { foo } from "./x";',
				'import { foo as bar } from "./x";',
				'import Foo from "./x";',
				'import * as ns from "./x";',
				'export { foo } from "./x";',
				'export { foo as baz } from "./x";',
				"export { foo };",
				'export * from "./x";',
				'import "./side";',
			].join("\n"),
		);
		expect(pick(refs, "import")).toEqual([
			{ name: "foo", receiver: undefined, alias: undefined, specifier: "./x", importKind: "named", line: 1, col: 10, endCol: 12 },
			{ name: "foo", receiver: undefined, alias: "bar", specifier: "./x", importKind: "named", line: 2, col: 10, endCol: 12 },
			{ name: "Foo", receiver: undefined, alias: undefined, specifier: "./x", importKind: "default", line: 3, col: 8, endCol: 10 },
			{ name: "ns", receiver: undefined, alias: undefined, specifier: "./x", importKind: "namespace", line: 4, col: 13, endCol: 14 },
		]);
		expect(pick(refs, "export")).toEqual([
			{ name: "foo", receiver: undefined, alias: undefined, specifier: "./x", importKind: undefined, line: 5, col: 10, endCol: 12 },
			{ name: "foo", receiver: undefined, alias: "baz", specifier: "./x", importKind: undefined, line: 6, col: 10, endCol: 12 },
			{ name: "foo", receiver: undefined, alias: undefined, specifier: undefined, importKind: undefined, line: 7, col: 10, endCol: 12 },
		]);
		expect(reexports).toEqual([
			{ file: "src/r.ts", exportedName: "foo", sourceName: "foo", specifier: "./x" },
			{ file: "src/r.ts", exportedName: "baz", sourceName: "foo", specifier: "./x" },
		]);
		expect(refs.some((r) => r.range.line === 8 || r.range.line === 9)).toBe(false);
	});

	it("emits call, new, member, type, extends, implements, jsx, decorator with token ranges", async () => {
		const { refs } = await refsOf(
			[
				"class Base {} interface I {}",
				"@Injectable()",
				"class Svc extends Base implements I {",
				"  run(x: Base, y: Map<string, I>): I { this.open(); return cfg.timeout as I; }",
				"  open() { const b = new Base(); return <Button prop={1} /> }",
				"}",
			].join("\n"),
			"src/r.tsx",
		);
		expect(pick(refs, "call")).toEqual([
			{ name: "open", receiver: "this", alias: undefined, specifier: undefined, importKind: undefined, line: 4, col: 45, endCol: 48 },
		]);
		expect(pick(refs, "new")).toEqual([
			{ name: "Base", receiver: undefined, alias: undefined, specifier: undefined, importKind: undefined, line: 5, col: 26, endCol: 29 },
		]);
		expect(pick(refs, "member").map((m) => [m.name, m.receiver])).toEqual([["timeout", "cfg"]]);
		expect(pick(refs, "type").map((t) => t.name)).toEqual(["Base", "Map", "I", "I", "I"]);
		expect(pick(refs, "extends").map((t) => t.name)).toEqual(["Base"]);
		expect(pick(refs, "implements").map((t) => t.name)).toEqual(["I"]);
		expect(pick(refs, "jsx").map((t) => t.name)).toEqual(["Button"]);
		expect(pick(refs, "decorator").map((t) => t.name)).toEqual(["Injectable"]);
		const thisCall = refs.find((r) => r.kind === "call")!;
		expect(thisCall.enclosingQualifiedName).toBe("Svc.run");
		expect(thisCall.enclosingClass).toBe("Svc");
	});

	it("does not emit a declaration's own name, and never emits read/write kinds", async () => {
		const { refs } = await refsOf("export function handler() { return 1; }\nconst h = handler;\nlet v = 1; v = 2;");
		expect(refs.filter((r) => r.range.line === 1)).toEqual([]);
		expect(refs.map((r) => r.kind)).not.toContain("read");
		expect(refs.map((r) => r.kind)).not.toContain("write");
	});

	it("is deterministic across two parses", async () => {
		const src = 'import { a } from "./a";\nexport class C { m(): a.T { return a.f(); } }';
		const one = await refsOf(src);
		const two = await refsOf(src);
		expect(one).toEqual(two);
	});

	it("handles a file with syntax errors without throwing and keeps recovered refs", async () => {
		const { refs } = await refsOf("import { ok } from \"./ok\";\nconst a = ok();\nfunction broken( {\nconst b = cfg.timeout;\n");
		expect(refs.some((r) => r.kind === "import" && r.name === "ok")).toBe(true);
		expect(refs.some((r) => r.kind === "call" && r.name === "ok" && r.range.line === 2)).toBe(true);
	});

	it("visits non-identifier callees (IIFE, chained calls, casts)", async () => {
		const { refs } = await refsOf("(() => { foo(); new Bar(); x.y; })();\na()();\n(x as Foo)();\nx[y.z]();");
		const has = (kind: string, name: string) => refs.some((r) => r.kind === kind && r.name === name);
		expect(has("call", "foo")).toBe(true);
		expect(has("new", "Bar")).toBe(true);
		expect(has("member", "y")).toBe(true);
		expect(has("call", "a")).toBe(true);
		expect(has("type", "Foo")).toBe(true);
		expect(has("member", "z")).toBe(true);
	});

	it("emits extends for JavaScript classes", async () => {
		const { refs } = await refsOf("class A extends B {}\nclass C extends ns.D {}", "src/r.js");
		expect(refs.filter((r) => r.kind === "extends").map((r) => [r.name, r.receiver])).toEqual([
			["B", undefined],
			["D", "ns"],
		]);
	});

	it("does not emit type-parameter declarations as type refs", async () => {
		const { refs } = await refsOf(
			"function f<T extends Base>(x: T): T { return x; }\ntype M<K> = { [P in keyof K]: K[P] };\ntype U<V> = V extends Array<infer E> ? E : never;",
		);
		const types = refs.filter((r) => r.kind === "type");
		expect(types.filter((r) => r.range.line === 1 && r.range.column < 25).map((r) => r.name)).toEqual(["Base"]);
		expect(types.filter((r) => r.range.line === 2).map((r) => r.name)).toEqual(["K", "K", "P"]);
		expect(types.filter((r) => r.range.line === 3 && r.name === "E").length).toBe(1);
	});
});
