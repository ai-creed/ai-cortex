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
			"import { foo } from \"./bar\";",
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
			"import { foo as baz } from \"./bar\";",
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
			"import Bar from \"./bar\";",
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
			"import * as utils from \"./utils\";",
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
			"import { readFileSync } from \"node:fs\";",
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
			"import x from \"./foo\";\nimport { y } from \"../bar/baz\";\nimport \"external\";",
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
			"import { x } from \"react\";",
		);
		expect(sites).toEqual([]);
	});

	it("strips known TS extension from candidate for import './b.ts'", async () => {
		const sites = await adapter.extractImports(
			"",
			"src/a.ts",
			"import x from \"./b.ts\";",
		);
		expect(sites).toHaveLength(1);
		expect(sites[0].candidate).toBe("src/b");
		expect(sites[0].rawSpecifier).toBe("./b.ts");
	});

	it("strips .js extension from candidate for import './util.js'", async () => {
		const sites = await adapter.extractImports(
			"",
			"src/a.ts",
			"import { helper } from \"./util.js\";",
		);
		expect(sites).toHaveLength(1);
		expect(sites[0].candidate).toBe("src/util");
	});
});
