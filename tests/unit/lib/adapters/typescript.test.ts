// tests/unit/lib/adapters/typescript.test.ts
import { describe, expect, it, beforeAll } from "vitest";
import { createTypescriptAdapter } from "../../../../src/lib/adapters/typescript.js";
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
		expect(result.functions).toContainEqual(
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
		expect(result.functions).toContainEqual(
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
		expect(result.functions).toContainEqual(
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
		expect(result.functions).toContainEqual(
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
		expect(result.functions).toContainEqual(
			expect.objectContaining({ qualifiedName: "Foo.bar" }),
		);
		expect(result.functions).toContainEqual(
			expect.objectContaining({ qualifiedName: "Foo.render" }),
		);
	});

	it("marks methods of exported class as exported", async () => {
		const result = await adapter.extractCallGraph!(
			"",
			"src/svc.ts",
			"export class Svc { run() {} }",
		);
		expect(result.functions).toContainEqual(
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
		const names = result.functions.map((f) => f.qualifiedName);
		expect(names).toContain("A.render");
		expect(names).toContain("B.render");
	});

	it("extracts named default export function", async () => {
		const result = await adapter.extractCallGraph!(
			"",
			"src/do.ts",
			"export default function doThing() {}",
		);
		expect(result.functions).toContainEqual(
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
		expect(result.functions).toContainEqual(
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
		expect(result.functions).toContainEqual(
			expect.objectContaining({
				qualifiedName: "Ctrl",
				isDefaultExport: true,
			}),
		);
		expect(result.functions).toContainEqual(
			expect.objectContaining({
				qualifiedName: "Ctrl.handle",
				exported: true,
			}),
		);
	});

	it("reports accurate line numbers", async () => {
		const source = "// comment\n\nfunction foo() {}\n";
		const result = await adapter.extractCallGraph!("", "src/foo.ts", source);
		const foo = result.functions.find((f) => f.qualifiedName === "foo");
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
		expect(result.functions).toHaveLength(0);
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
		const fn = r.functions.find((f) => f.qualifiedName === "multi");
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
		return r.symbols!;
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
		const ns = r.symbols!.filter((s) => s.qualifiedName === "N");
		expect(ns).toHaveLength(2);
		expect(ns.every((s) => s.kind === "namespace")).toBe(true);
		expect(r.functions.filter((f) => f.qualifiedName === "N.C")).toHaveLength(1);
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

	it("functions output equals the A2.2 projection of symbols", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"src/s.ts",
			"export class C { m() {} }\nexport const f = () => 1;\nfunction g() {}\nexport default function () {}",
		);
		const { functionsFromSymbols } = await import("../../../../src/lib/symbols.js");
		expect(r.functions).toEqual(functionsFromSymbols(r.symbols!));
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
		expect(r.symbols!.map((s) => s.qualifiedName)).toEqual(["fetch"]);
		expect(r.functions.map((f) => f.qualifiedName)).toEqual(["fetch"]);
		expect(r.rawCalls.map((c) => c.callerQualifiedName)).not.toContain("fetch");
		expect(r.rawCalls.find((c) => c.rawCallee === "go")).toBeUndefined();
	});

	it("methods of an anonymous class expression are not indexed", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"src/s.ts",
			"export const X = mixin(class { m() { foo(); } });",
		);
		expect(r.symbols!.map((s) => s.qualifiedName)).toEqual(["X"]);
		expect(r.rawCalls.find((c) => c.rawCallee === "foo")).toBeUndefined();
	});

	it("dotted namespace names get one name range per segment", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"src/s.ts",
			"namespace A.B { export function f() {} }",
		);
		const a = r.symbols!.find((s) => s.qualifiedName === "A")!;
		const b = r.symbols!.find((s) => s.qualifiedName === "A.B")!;
		expect(a.nameRange).toEqual({ line: 1, column: 11, endLine: 1, endColumn: 11 });
		expect(b.nameRange).toEqual({ line: 1, column: 13, endLine: 1, endColumn: 13 });
		expect(r.symbols!.some((s) => s.qualifiedName === "A.B.f")).toBe(true);
	});
});
