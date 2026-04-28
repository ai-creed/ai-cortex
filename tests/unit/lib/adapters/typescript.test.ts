// tests/unit/lib/adapters/typescript.test.ts
import { describe, expect, it, beforeAll } from "vitest";
import { createTypescriptAdapter } from "../../../../src/lib/adapters/typescript.js";
import type { LangAdapter } from "../../../../src/lib/lang-adapter.js";

let adapter: LangAdapter;

beforeAll(async () => {
	adapter = await createTypescriptAdapter();
});

describe("typescript adapter — function extraction", () => {
	it("extracts named function declaration", () => {
		const result = adapter.extractFile(
			"function foo() { return 1; }",
			"src/foo.ts",
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

	it("extracts exported function declaration", () => {
		const result = adapter.extractFile(
			"export function bar() {}",
			"src/bar.ts",
		);
		expect(result.functions).toContainEqual(
			expect.objectContaining({
				qualifiedName: "bar",
				exported: true,
				isDefaultExport: false,
			}),
		);
	});

	it("extracts arrow function assigned to const", () => {
		const result = adapter.extractFile(
			"const baz = () => {};",
			"src/baz.ts",
		);
		expect(result.functions).toContainEqual(
			expect.objectContaining({
				qualifiedName: "baz",
				exported: false,
			}),
		);
	});

	it("extracts exported arrow function", () => {
		const result = adapter.extractFile(
			"export const qux = () => {};",
			"src/qux.ts",
		);
		expect(result.functions).toContainEqual(
			expect.objectContaining({
				qualifiedName: "qux",
				exported: true,
				isDefaultExport: false,
			}),
		);
	});

	it("extracts class method with qualified name", () => {
		const result = adapter.extractFile(
			"class Foo { bar() {} render() {} }",
			"src/foo.ts",
		);
		expect(result.functions).toContainEqual(
			expect.objectContaining({ qualifiedName: "Foo.bar" }),
		);
		expect(result.functions).toContainEqual(
			expect.objectContaining({ qualifiedName: "Foo.render" }),
		);
	});

	it("marks methods of exported class as exported", () => {
		const result = adapter.extractFile(
			"export class Svc { run() {} }",
			"src/svc.ts",
		);
		expect(result.functions).toContainEqual(
			expect.objectContaining({
				qualifiedName: "Svc.run",
				exported: true,
			}),
		);
	});

	it("does not collapse same-name methods in different classes", () => {
		const result = adapter.extractFile(
			"class A { render() {} }\nclass B { render() {} }",
			"src/ab.ts",
		);
		const names = result.functions.map((f) => f.qualifiedName);
		expect(names).toContain("A.render");
		expect(names).toContain("B.render");
	});

	it("extracts named default export function", () => {
		const result = adapter.extractFile(
			"export default function doThing() {}",
			"src/do.ts",
		);
		expect(result.functions).toContainEqual(
			expect.objectContaining({
				qualifiedName: "doThing",
				exported: true,
				isDefaultExport: true,
			}),
		);
	});

	it("synthesizes 'default' name for anonymous default export", () => {
		const result = adapter.extractFile(
			"export default () => {};",
			"src/anon.ts",
		);
		expect(result.functions).toContainEqual(
			expect.objectContaining({
				qualifiedName: "default",
				exported: true,
				isDefaultExport: true,
			}),
		);
	});

	it("extracts default-exported class with methods", () => {
		const result = adapter.extractFile(
			"export default class Ctrl { handle() {} }",
			"src/ctrl.ts",
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

	it("reports accurate line numbers", () => {
		const source = "// comment\n\nfunction foo() {}\n";
		const result = adapter.extractFile(source, "src/foo.ts");
		const foo = result.functions.find((f) => f.qualifiedName === "foo");
		expect(foo?.line).toBe(3);
	});
});

describe("typescript adapter — raw call site extraction", () => {
	it("extracts direct function call", () => {
		const result = adapter.extractFile(
			"function a() { foo(); }",
			"src/a.ts",
		);
		expect(result.rawCalls).toContainEqual(
			expect.objectContaining({
				rawCallee: "foo",
				kind: "call",
				callerFile: "src/a.ts",
			}),
		);
	});

	it("extracts new expression", () => {
		const result = adapter.extractFile(
			"function a() { new Foo(); }",
			"src/a.ts",
		);
		expect(result.rawCalls).toContainEqual(
			expect.objectContaining({
				rawCallee: "Foo",
				kind: "new",
			}),
		);
	});

	it("extracts method call with receiver", () => {
		const result = adapter.extractFile(
			"function a() { obj.method(); }",
			"src/a.ts",
		);
		expect(result.rawCalls).toContainEqual(
			expect.objectContaining({
				rawCallee: "obj.method",
				kind: "method",
			}),
		);
	});

	it("extracts this.method call", () => {
		const result = adapter.extractFile(
			"class Foo { bar() { this.baz(); } baz() {} }",
			"src/foo.ts",
		);
		expect(result.rawCalls).toContainEqual(
			expect.objectContaining({
				rawCallee: "this.baz",
				kind: "method",
				callerQualifiedName: "Foo.bar",
			}),
		);
	});

	it("sets callerQualifiedName to enclosing function", () => {
		const result = adapter.extractFile(
			"function outer() { inner(); }\nfunction inner() {}",
			"src/x.ts",
		);
		const call = result.rawCalls.find((c) => c.rawCallee === "inner");
		expect(call?.callerQualifiedName).toBe("outer");
	});
});

describe("typescript adapter — import binding extraction", () => {
	it("extracts named import", () => {
		const result = adapter.extractFile(
			"import { foo } from \"./bar\";",
			"src/a.ts",
		);
		expect(result.importBindings).toContainEqual({
			localName: "foo",
			importedName: "foo",
			fromSpecifier: "./bar",
			bindingKind: "named",
		});
	});

	it("extracts aliased import", () => {
		const result = adapter.extractFile(
			"import { foo as baz } from \"./bar\";",
			"src/a.ts",
		);
		expect(result.importBindings).toContainEqual({
			localName: "baz",
			importedName: "foo",
			fromSpecifier: "./bar",
			bindingKind: "named",
		});
	});

	it("extracts default import", () => {
		const result = adapter.extractFile(
			"import Bar from \"./bar\";",
			"src/a.ts",
		);
		expect(result.importBindings).toContainEqual({
			localName: "Bar",
			importedName: "default",
			fromSpecifier: "./bar",
			bindingKind: "default",
		});
	});

	it("extracts namespace import", () => {
		const result = adapter.extractFile(
			"import * as utils from \"./utils\";",
			"src/a.ts",
		);
		expect(result.importBindings).toContainEqual({
			localName: "utils",
			importedName: "*",
			fromSpecifier: "./utils",
			bindingKind: "namespace",
		});
	});

	it("ignores non-relative imports", () => {
		const result = adapter.extractFile(
			"import { readFileSync } from \"node:fs\";",
			"src/a.ts",
		);
		expect(result.importBindings).toHaveLength(0);
	});
});

describe("typescript adapter — edge cases", () => {
	it("returns empty result for empty file", () => {
		const result = adapter.extractFile("", "src/empty.ts");
		expect(result.functions).toHaveLength(0);
		expect(result.rawCalls).toHaveLength(0);
		expect(result.importBindings).toHaveLength(0);
	});

	it("handles file with syntax errors gracefully", () => {
		const result = adapter.extractFile(
			"function foo( { bar(); }",
			"src/broken.ts",
		);
		// Should not throw — tree-sitter does partial parsing
		expect(result).toBeDefined();
	});
});

describe("typescript adapter — import sites", () => {
	it("emits a RawImportSite per relative import", () => {
		const sites = adapter.extractImportSites(
			"import x from \"./foo\";\nimport { y } from \"../bar/baz\";\nimport \"external\";",
			"src/main.ts",
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

	it("ignores non-relative imports", () => {
		const sites = adapter.extractImportSites(
			"import { x } from \"react\";",
			"src/main.ts",
		);
		expect(sites).toEqual([]);
	});
});
