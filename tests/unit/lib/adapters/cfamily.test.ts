import { describe, expect, it, beforeAll } from "vitest";
import {
  createCAdapter,
  createCppAdapter,
} from "../../../../src/lib/adapters/cfamily.js";
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
    expect(r.functions).toContainEqual(
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
    expect(r.functions).toContainEqual(
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
    expect(r.functions).toContainEqual(
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
    expect(r.rawCalls).toContainEqual({
      callerQualifiedName: "main",
      callerFile: "src/main.c",
      rawCallee: "foo",
      kind: "call",
    });
  });

  it("treats . and -> member access as kind 'method'", async () => {
    const r = await cAdapter.extractCallGraph!(
      "",
      "src/main.c",
      "struct S { int (*fn)(int); }; int main(void) { struct S* p; p->fn(1); }",
    );
    expect(
      r.rawCalls.find((c) => c.rawCallee.endsWith(".fn") && c.kind === "method"),
    ).toBeDefined();
  });
});

describe("c adapter — import sites (#include)", () => {
  it("emits a RawImportSite for #include \"foo.h\"", async () => {
    const sites = await cAdapter.extractImports(
      "",
      "src/main.c",
      "#include \"foo.h\"\nint main(void) { return 0; }",
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
    expect(r.functions).toContainEqual(
      expect.objectContaining({ qualifiedName: "foo::bar" }),
    );
  });

  it("prefixes nested namespace on functions", async () => {
    const r = await cppAdapter.extractCallGraph!(
      "",
      "src/x.cpp",
      "namespace a { namespace b { void c() {} } }",
    );
    expect(r.functions).toContainEqual(
      expect.objectContaining({ qualifiedName: "a::b::c" }),
    );
  });

  it("emits Class::method for inline methods inside class body", async () => {
    const r = await cppAdapter.extractCallGraph!(
      "",
      "src/x.cpp",
      "class Foo { public: void bar() {} };",
    );
    expect(r.functions).toContainEqual(
      expect.objectContaining({ qualifiedName: "Foo::bar" }),
    );
  });

  it("emits Class::method for out-of-line definitions", async () => {
    const r = await cppAdapter.extractCallGraph!(
      "",
      "src/x.cpp",
      "class Foo { public: void bar(); }; void Foo::bar() {}",
    );
    expect(r.functions.filter((f) => f.qualifiedName === "Foo::bar"))
      .toHaveLength(2); // declaration + definition
    expect(
      r.functions.find(
        (f) => f.qualifiedName === "Foo::bar" && f.isDeclarationOnly === true,
      ),
    ).toBeDefined();
    expect(
      r.functions.find(
        (f) => f.qualifiedName === "Foo::bar" && f.isDeclarationOnly === false,
      ),
    ).toBeDefined();
  });
});

describe("cpp adapter — qualified calls and new", () => {
  it("extracts Foo::bar() as a call with callee 'Foo::bar'", async () => {
    const cppAdapter2 = await createCppAdapter();
    const r = await cppAdapter2.extractCallGraph!(
      "",
      "src/x.cpp",
      "class Foo { public: static void bar() {} }; void main2() { Foo::bar(); }",
    );
    expect(r.rawCalls).toContainEqual(
      expect.objectContaining({ rawCallee: "Foo::bar", kind: "call" }),
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
    expect(r.functions).toHaveLength(0);
  });

  it("does not emit a function-pointer struct field as a method declaration", async () => {
    const cppAdapter2 = await createCppAdapter();
    const r = await cppAdapter2.extractCallGraph!(
      "",
      "src/x.h",
      "struct Sorter { int (*compare)(int, int); };",
    );
    const cmpFn = r.functions.find((f) => f.qualifiedName.includes("compare"));
    expect(cmpFn).toBeUndefined();
  });

  it("still emits a real function prototype from a declaration", async () => {
    const cppAdapter2 = await createCppAdapter();
    const r = await cppAdapter2.extractCallGraph!(
      "",
      "src/utils.h",
      "int add(int a, int b);",
    );
    const fn = r.functions.find((f) => f.qualifiedName === "add");
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
      new Set([".cpp", ".cc", ".cxx", ".c++", ".hpp", ".hh", ".hxx", ".h++", ".h"]),
    );
  });

  it("c adapter can parse an empty source without throwing", async () => {
    const r = await cAdapter.extractCallGraph!("", "x.c", "");
    expect(r).toEqual({ functions: [], rawCalls: [], importBindings: [] });
    expect(await cAdapter.extractImports("", "x.c", "")).toEqual([]);
  });

  it("cpp adapter can parse an empty source without throwing", async () => {
    const r = await cppAdapter.extractCallGraph!("", "x.cpp", "");
    expect(r).toEqual({ functions: [], rawCalls: [], importBindings: [] });
    expect(await cppAdapter.extractImports("", "x.cpp", "")).toEqual([]);
  });
});
