import { describe, expect, it, beforeAll } from "vitest";
import {
  createCAdapter,
  createCppAdapter,
} from "../../../../src/lib/adapters/cfamily.js";
import type { LangAdapter } from "../../../../src/lib/lang-adapter.js";

let cAdapter: LangAdapter;
let cppAdapter: LangAdapter;

beforeAll(async () => {
  cAdapter = await createCAdapter();
  cppAdapter = await createCppAdapter();
});

describe("c adapter — function extraction", () => {
  it("extracts a plain function definition as exported (non-static)", () => {
    const r = cAdapter.extractFile(
      "int foo(void) { return 0; }",
      "src/foo.c",
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

  it("marks static functions as not exported", () => {
    const r = cAdapter.extractFile(
      "static int helper(void) { return 0; }",
      "src/foo.c",
    );
    expect(r.functions).toContainEqual(
      expect.objectContaining({
        qualifiedName: "helper",
        exported: false,
        isDeclarationOnly: false,
      }),
    );
  });

  it("emits header declarations as isDeclarationOnly", () => {
    const r = cAdapter.extractFile(
      "int compute(int x);",
      "src/foo.h",
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
  it("extracts plain calls with kind 'call'", () => {
    const r = cAdapter.extractFile(
      "int foo(void); int main(void) { return foo(); }",
      "src/main.c",
    );
    expect(r.rawCalls).toContainEqual({
      callerQualifiedName: "main",
      callerFile: "src/main.c",
      rawCallee: "foo",
      kind: "call",
    });
  });

  it("treats . and -> member access as kind 'method'", () => {
    const r = cAdapter.extractFile(
      "struct S { int (*fn)(int); }; int main(void) { struct S* p; p->fn(1); }",
      "src/main.c",
    );
    expect(
      r.rawCalls.find((c) => c.rawCallee.endsWith(".fn") && c.kind === "method"),
    ).toBeDefined();
  });
});

describe("c adapter — import sites (#include)", () => {
  it("emits a RawImportSite for #include \"foo.h\"", () => {
    const sites = cAdapter.extractImportSites(
      `#include "foo.h"\nint main(void) { return 0; }`,
      "src/main.c",
    );
    expect(sites).toHaveLength(1);
    expect(sites[0]).toEqual({
      from: "src/main.c",
      rawSpecifier: "foo.h",
      candidate: "src/foo.h",
    });
  });

  it("ignores #include <stdio.h> system headers", () => {
    const sites = cAdapter.extractImportSites(
      `#include <stdio.h>\nint main(void) { return 0; }`,
      "src/main.c",
    );
    expect(sites).toEqual([]);
  });
});

describe("cpp adapter — namespace and class extraction", () => {
  it("prefixes namespace name on functions", () => {
    const r = cppAdapter.extractFile(
      `namespace foo { void bar() {} }`,
      "src/x.cpp",
    );
    expect(r.functions).toContainEqual(
      expect.objectContaining({ qualifiedName: "foo::bar" }),
    );
  });

  it("prefixes nested namespace on functions", () => {
    const r = cppAdapter.extractFile(
      `namespace a { namespace b { void c() {} } }`,
      "src/x.cpp",
    );
    expect(r.functions).toContainEqual(
      expect.objectContaining({ qualifiedName: "a::b::c" }),
    );
  });

  it("emits Class::method for inline methods inside class body", () => {
    const r = cppAdapter.extractFile(
      `class Foo { public: void bar() {} };`,
      "src/x.cpp",
    );
    expect(r.functions).toContainEqual(
      expect.objectContaining({ qualifiedName: "Foo::bar" }),
    );
  });

  it("emits Class::method for out-of-line definitions", () => {
    const r = cppAdapter.extractFile(
      `class Foo { public: void bar(); }; void Foo::bar() {}`,
      "src/x.cpp",
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

describe("cfamily adapter — boot", () => {
  it("c adapter reports the right extensions", () => {
    expect(cAdapter.extensions).toEqual([".c"]);
  });

  it("cpp adapter reports the right extensions", () => {
    expect(new Set(cppAdapter.extensions)).toEqual(
      new Set([".cpp", ".cc", ".cxx", ".c++", ".hpp", ".hh", ".hxx", ".h++", ".h"]),
    );
  });

  it("c adapter can parse an empty source without throwing", () => {
    const r = cAdapter.extractFile("", "x.c");
    expect(r).toEqual({ functions: [], rawCalls: [], importBindings: [] });
    expect(cAdapter.extractImportSites("", "x.c")).toEqual([]);
  });

  it("cpp adapter can parse an empty source without throwing", () => {
    const r = cppAdapter.extractFile("", "x.cpp");
    expect(r).toEqual({ functions: [], rawCalls: [], importBindings: [] });
    expect(cppAdapter.extractImportSites("", "x.cpp")).toEqual([]);
  });
});
