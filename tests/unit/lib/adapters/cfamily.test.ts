import { describe, expect, it, beforeAll } from "vitest";
import {
	createCAdapter,
	createCppAdapter,
} from "../../../../src/lib/adapters/cfamily.js";
import { functionsFromSymbols } from "../../../../src/lib/symbols.js";
import type { LanguageAdapter } from "../../../../src/lib/lang-adapter.js";

let cAdapter: LanguageAdapter;
let cppAdapter: LanguageAdapter;

beforeAll(async () => {
	cAdapter = await createCAdapter();
	cppAdapter = await createCppAdapter();
});

describe("c adapter — function extraction", () => {
	it("extracts a plain function definition as exported (non-static)", async () => {
		const r = await cAdapter.extractCallGraph!(
			"",
			"src/foo.c",
			"int foo(void) { return 0; }",
		);
		expect(functionsFromSymbols(r.symbols)).toContainEqual(
			expect.objectContaining({
				qualifiedName: "foo",
				file: "src/foo.c",
				exported: true,
				isDefaultExport: false,
				isDeclarationOnly: false,
			}),
		);
	});

	it("marks static functions as not exported", async () => {
		const r = await cAdapter.extractCallGraph!(
			"",
			"src/foo.c",
			"static int helper(void) { return 0; }",
		);
		expect(functionsFromSymbols(r.symbols)).toContainEqual(
			expect.objectContaining({
				qualifiedName: "helper",
				exported: false,
				isDeclarationOnly: false,
			}),
		);
	});

	it("emits header declarations as isDeclarationOnly", async () => {
		const r = await cAdapter.extractCallGraph!(
			"",
			"src/foo.h",
			"int compute(int x);",
		);
		expect(functionsFromSymbols(r.symbols)).toContainEqual(
			expect.objectContaining({
				qualifiedName: "compute",
				file: "src/foo.h",
				exported: true,
				isDeclarationOnly: true,
			}),
		);
	});
});

describe("c adapter — raw call extraction", () => {
	it("extracts plain calls with kind 'call'", async () => {
		const r = await cAdapter.extractCallGraph!(
			"",
			"src/main.c",
			"int foo(void); int main(void) { return foo(); }",
		);
		expect(r.rawCalls).toContainEqual(
			expect.objectContaining({
				callerQualifiedName: "main",
				callerFile: "src/main.c",
				rawCallee: "foo",
				kind: "call",
			}),
		);
	});

	it("treats . and -> member access as kind 'method'", async () => {
		const r = await cAdapter.extractCallGraph!(
			"",
			"src/main.c",
			"struct S { int (*fn)(int); }; int main(void) { struct S* p; p->fn(1); }",
		);
		expect(
			r.rawCalls.find(
				(c) => c.rawCallee.endsWith(".fn") && c.kind === "method",
			),
		).toBeDefined();
	});
});

describe("c adapter — import sites (#include)", () => {
	it('emits a RawImportSite for #include "foo.h"', async () => {
		const sites = await cAdapter.extractImports(
			"",
			"src/main.c",
			'#include "foo.h"\nint main(void) { return 0; }',
		);
		expect(sites).toHaveLength(1);
		expect(sites[0]).toEqual({
			from: "src/main.c",
			rawSpecifier: "foo.h",
			candidate: "src/foo.h",
		});
	});

	it("ignores #include <stdio.h> system headers", async () => {
		const sites = await cAdapter.extractImports(
			"",
			"src/main.c",
			"#include <stdio.h>\nint main(void) { return 0; }",
		);
		expect(sites).toEqual([]);
	});
});

describe("cpp adapter — namespace and class extraction", () => {
	it("prefixes namespace name on functions", async () => {
		const r = await cppAdapter.extractCallGraph!(
			"",
			"src/x.cpp",
			"namespace foo { void bar() {} }",
		);
		expect(functionsFromSymbols(r.symbols)).toContainEqual(
			expect.objectContaining({ qualifiedName: "foo.bar" }),
		);
	});

	it("prefixes nested namespace on functions", async () => {
		const r = await cppAdapter.extractCallGraph!(
			"",
			"src/x.cpp",
			"namespace a { namespace b { void c() {} } }",
		);
		expect(functionsFromSymbols(r.symbols)).toContainEqual(
			expect.objectContaining({ qualifiedName: "a.b.c" }),
		);
	});

	it("emits Class.method for inline methods inside class body", async () => {
		const r = await cppAdapter.extractCallGraph!(
			"",
			"src/x.cpp",
			"class Foo { public: void bar() {} };",
		);
		expect(functionsFromSymbols(r.symbols)).toContainEqual(
			expect.objectContaining({ qualifiedName: "Foo.bar" }),
		);
	});

	it("emits Class.method for out-of-line definitions", async () => {
		const r = await cppAdapter.extractCallGraph!(
			"",
			"src/x.cpp",
			"class Foo { public: void bar(); }; void Foo::bar() {}",
		);
		const symbols = r.symbols!.filter((s) => s.qualifiedName === "Foo.bar");
		expect(symbols.map((s) => s.isDeclarationOnly)).toEqual([true, false]); // declaration + definition
		const fns = functionsFromSymbols(r.symbols).filter((f) => f.qualifiedName === "Foo.bar");
		expect(fns).toHaveLength(1); // one functions row per key, definition preferred
		expect(fns[0].isDeclarationOnly).toBe(false);
	});
});

describe("cpp adapter — qualified calls and new", () => {
	it("extracts Foo::bar() as a call with callee 'Foo.bar'", async () => {
		const cppAdapter2 = await createCppAdapter();
		const r = await cppAdapter2.extractCallGraph!(
			"",
			"src/x.cpp",
			"class Foo { public: static void bar() {} }; void main2() { Foo::bar(); }",
		);
		expect(r.rawCalls).toContainEqual(
			expect.objectContaining({ rawCallee: "Foo.bar", kind: "call" }),
		);
	});

	it("extracts new Foo() as kind 'new'", async () => {
		const cppAdapter2 = await createCppAdapter();
		const r = await cppAdapter2.extractCallGraph!(
			"",
			"src/x.cpp",
			"class Foo {}; void main2() { Foo* f = new Foo(); }",
		);
		expect(r.rawCalls).toContainEqual(
			expect.objectContaining({ rawCallee: "Foo", kind: "new" }),
		);
	});
});

describe("cfamily — function-pointer variables not emitted as declarations", () => {
	it("does not emit a function-pointer variable as a function declaration", async () => {
		const cppAdapter2 = await createCppAdapter();
		const r = await cppAdapter2.extractCallGraph!(
			"",
			"src/x.cpp",
			"int (*cmp)(const void*, const void*);",
		);
		expect(functionsFromSymbols(r.symbols)).toHaveLength(0);
	});

	it("does not emit a function-pointer struct field as a method declaration", async () => {
		const cppAdapter2 = await createCppAdapter();
		const r = await cppAdapter2.extractCallGraph!(
			"",
			"src/x.h",
			"struct Sorter { int (*compare)(int, int); };",
		);
		const cmpFn = functionsFromSymbols(r.symbols).find((f) => f.qualifiedName.includes("compare"));
		expect(cmpFn).toBeUndefined();
	});

	it("still emits a real function prototype from a declaration", async () => {
		const cppAdapter2 = await createCppAdapter();
		const r = await cppAdapter2.extractCallGraph!(
			"",
			"src/utils.h",
			"int add(int a, int b);",
		);
		const fn = functionsFromSymbols(r.symbols).find((f) => f.qualifiedName === "add");
		expect(fn).toBeDefined();
		expect(fn?.isDeclarationOnly).toBe(true);
	});
});

describe("cfamily adapter — boot", () => {
	it("c adapter reports the right extensions", () => {
		expect(cAdapter.extensions).toEqual([".c"]);
	});

	it("cpp adapter reports the right extensions", () => {
		expect(new Set(cppAdapter.extensions)).toEqual(
			new Set([
				".cpp",
				".cc",
				".cxx",
				".c++",
				".hpp",
				".hh",
				".hxx",
				".h++",
				".h",
			]),
		);
	});

	it("c adapter can parse an empty source without throwing", async () => {
		const r = await cAdapter.extractCallGraph!("", "x.c", "");
		expect(r).toEqual({ symbols: [], rawCalls: [], rawRefs: [], reexports: [], importBindings: [] });
		expect(await cAdapter.extractImports("", "x.c", "")).toEqual([]);
	});

	it("cpp adapter can parse an empty source without throwing", async () => {
		const r = await cppAdapter.extractCallGraph!("", "x.cpp", "");
		expect(r).toEqual({ symbols: [], rawCalls: [], rawRefs: [], reexports: [], importBindings: [] });
		expect(await cppAdapter.extractImports("", "x.cpp", "")).toEqual([]);
	});
});

describe("c/c++ adapter — range and site emission (unit)", () => {
	it("populates column/endLine/endColumn on a multi-line function", async () => {
		const r = await cAdapter.extractCallGraph!(
			"",
			"src/r.c",
			"int multi(void) {\n  return 0;\n}",
		);
		const fn = functionsFromSymbols(r.symbols).find((f) => f.qualifiedName === "multi");
		expect(fn?.column).toBeGreaterThanOrEqual(1);
		expect(fn?.endLine).toBeGreaterThan(fn!.line);
		expect(fn?.endColumn).toBeGreaterThanOrEqual(1);
	});

	it("populates site on a plain call expression", async () => {
		const r = await cAdapter.extractCallGraph!(
			"",
			"src/c.c",
			"void callee(void);\nvoid caller(void) {\n  callee();\n}",
		);
		const call = r.rawCalls.find(
			(c) => c.rawCallee === "callee" && c.kind === "call",
		);
		expect(call?.site).toBeDefined();
		expect(call?.site?.line).toBe(3);
	});

	it("populates site on a C++ new expression", async () => {
		const r = await cppAdapter.extractCallGraph!(
			"",
			"src/n.cpp",
			"struct Thing {};\nvoid caller() {\n  new Thing();\n}",
		);
		const ctor = r.rawCalls.find((c) => c.kind === "new");
		expect(ctor?.site).toBeDefined();
	});
});

describe("cfamily adapter: symbols and refs (3.2)", () => {
	it("cpp: emits class, struct, enum, enum members, typedef, macro, method, out-of-line method with '.' separators", async () => {
		const cpp = await createCppAdapter();
		const r = await cpp.extractCallGraph!(
			"",
			"src/a.hpp",
			[
				"#define MAX 10",
				"#define SQ(x) ((x)*(x))",
				"typedef int Id;",
				"enum Color { Red, Green = 2 };",
				"struct Point { int x; };",
				"namespace ns { class Foo { public: void bar(); static int s; }; void Foo::bar() {} }",
				"int counter = 0;",
			].join("\n"),
		);
		const byQn = Object.fromEntries(r.symbols!.map((s) => [s.qualifiedName, s]));
		expect(byQn.MAX).toMatchObject({ kind: "macro" });
		expect(byQn.SQ).toMatchObject({ kind: "macro" });
		expect(byQn.Id).toMatchObject({ kind: "type" });
		expect(byQn.Color).toMatchObject({ kind: "enum" });
		expect(byQn["Color.Red"]).toMatchObject({ kind: "enum_member", containerQualifiedName: "Color" });
		expect(byQn["Color.Green"]).toMatchObject({ kind: "enum_member" });
		expect(byQn.Point).toMatchObject({ kind: "struct" });
		expect(byQn["Point.x"]).toMatchObject({ kind: "property" });
		expect(byQn["ns.Foo"]).toMatchObject({ kind: "class", containerQualifiedName: "ns" });
		const bars = r.symbols!.filter((s) => s.qualifiedName === "ns.Foo.bar");
		expect(bars.map((b) => b.isDeclarationOnly)).toEqual([true, false]);
		expect(byQn.counter).toMatchObject({ kind: "variable" });
		for (const s of r.symbols!) expect(s.qualifiedName).not.toContain("::");
		expect(functionsFromSymbols(r.symbols).filter((f) => f.qualifiedName === "ns.Foo.bar")).toHaveLength(1);
		expect(functionsFromSymbols(r.symbols).find((f) => f.qualifiedName === "ns.Foo.bar")!.isDeclarationOnly).toBe(false);
	});

	it("c: same-file prototype plus definition projects to one functions row", async () => {
		const c = await createCAdapter();
		const r = await c.extractCallGraph!("", "src/u.c", "int add(int a, int b);\nint add(int a, int b) { return a + b; }\n");
		expect(r.symbols!.filter((s) => s.qualifiedName === "add")).toHaveLength(2);
		expect(functionsFromSymbols(r.symbols).filter((f) => f.qualifiedName === "add")).toHaveLength(1);
		expect(functionsFromSymbols(r.symbols)[0].isDeclarationOnly).toBe(false);
	});

	it("emits call and new refs with receivers; qualified calls become receiver + member", async () => {
		const cpp = await createCppAdapter();
		const r = await cpp.extractCallGraph!(
			"",
			"src/m.cpp",
			"class Foo { public: static void bar() {} void run() { Foo::bar(); this->bar(); } };\nvoid main2() { Foo* f = new Foo(); f->run(); plain(); }",
		);
		const refs = r.rawRefs!.map((x) => [x.kind, x.name, x.receiver, x.enclosingClass]);
		expect(refs).toContainEqual(["call", "bar", "Foo", "Foo"]);
		expect(refs).toContainEqual(["call", "bar", "this", "Foo"]);
		expect(refs).toContainEqual(["new", "Foo", undefined, undefined]);
		expect(refs).toContainEqual(["call", "run", "f", undefined]);
		expect(refs).toContainEqual(["call", "plain", undefined, undefined]);
		const qualified = r.rawCalls.find((c) => c.rawCallee === "Foo.bar")!;
		expect(qualified.kind).toBe("call");
		expect(qualified.enclosingClass).toBe("Foo");
	});
});

describe("cfamily adapter: nested scopes agree across symbols, calls, and refs", () => {
	it("nested namespace and nested class share one dotted qualified name", async () => {
		const cpp = await createCppAdapter();
		const r = await cpp.extractCallGraph!(
			"",
			"src/n.cpp",
			"namespace a { namespace b { class Outer { public: class Inner { public: void go() { helper(); } }; }; } }",
		);
		expect(r.symbols!.map((s) => s.qualifiedName)).toContain("a.b.Outer.Inner.go");
		expect(r.rawCalls[0]).toMatchObject({ callerQualifiedName: "a.b.Outer.Inner.go", enclosingClass: "a.b.Outer.Inner" });
		expect(r.rawRefs![0]).toMatchObject({ enclosingQualifiedName: "a.b.Outer.Inner.go", enclosingClass: "a.b.Outer.Inner" });
	});

	it("out-of-line method call carries namespace-qualified class", async () => {
		const cpp = await createCppAdapter();
		const r = await cpp.extractCallGraph!(
			"",
			"src/o.cpp",
			"namespace ns { class Foo { void bar(); }; void Foo::bar() { baz(); } }",
		);
		expect(r.rawCalls[0]).toMatchObject({ callerQualifiedName: "ns.Foo.bar", enclosingClass: "ns.Foo" });
		expect(r.rawRefs![0]).toMatchObject({ enclosingQualifiedName: "ns.Foo.bar", enclosingClass: "ns.Foo" });
	});
});

describe("cfamily adapter: typedef and new edge cases", () => {
	it("anonymous typedef struct fields are scoped under the typedef name", async () => {
		const c = await createCAdapter();
		const r = await c.extractCallGraph!("", "src/p.c", "typedef struct { int a; int b; } Pt;");
		const byQn = Object.fromEntries(r.symbols!.map((s) => [s.qualifiedName, s]));
		expect(byQn.Pt).toMatchObject({ kind: "type" });
		expect(byQn["Pt.a"]).toMatchObject({ kind: "property", containerQualifiedName: "Pt" });
		expect(byQn["Pt.b"]).toMatchObject({ kind: "property", containerQualifiedName: "Pt" });
		expect(byQn.a).toBeUndefined();
	});

	it("function-pointer typedef is named by its identifier", async () => {
		const c = await createCAdapter();
		const r = await c.extractCallGraph!("", "src/cb.c", "typedef int (*cb)(int);");
		expect(r.symbols!.filter((s) => s.kind === "type").map((s) => s.qualifiedName)).toEqual(["cb"]);
	});

	it("new with a qualified type uses '.' and splits receiver from name", async () => {
		const cpp = await createCppAdapter();
		const r = await cpp.extractCallGraph!("", "src/q.cpp", "void f() { auto* x = new ns::Foo(); }");
		expect(r.rawCalls.find((c) => c.kind === "new")!.rawCallee).toBe("ns.Foo");
		expect(r.rawRefs!.map((x) => [x.kind, x.name, x.receiver])).toContainEqual(["new", "Foo", "ns"]);
	});
});
