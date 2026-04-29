import { describe, it, expect, beforeAll } from "vitest";
import { createPythonAdapter } from "../../../../src/lib/adapters/python.js";
import type { LangAdapter } from "../../../../src/lib/lang-adapter.js";

let adapter: LangAdapter;

beforeAll(async () => {
  adapter = await createPythonAdapter();
});

describe("python adapter — function extraction", () => {
  it("extracts module-level def as exported", () => {
    const r = adapter.extractFile("def foo():\n  pass\n", "pkg/foo.py");
    expect(r.functions).toContainEqual(
      expect.objectContaining({
        qualifiedName: "foo",
        file: "pkg/foo.py",
        exported: true,
        isDefaultExport: false,
      }),
    );
  });

  it("extracts async def", () => {
    const r = adapter.extractFile("async def bar():\n  pass\n", "pkg/foo.py");
    expect(r.functions).toContainEqual(
      expect.objectContaining({ qualifiedName: "bar", exported: true }),
    );
  });

  it("extracts class method with ClassName.method qualified name", () => {
    const r = adapter.extractFile(
      "class Model:\n  def save(self):\n    pass\n  def finalize(self):\n    pass\n",
      "pkg/models.py",
    );
    expect(r.functions).toContainEqual(
      expect.objectContaining({ qualifiedName: "Model.save" }),
    );
    expect(r.functions).toContainEqual(
      expect.objectContaining({ qualifiedName: "Model.finalize" }),
    );
  });

  it("extracts decorated function", () => {
    const r = adapter.extractFile(
      "@property\ndef foo(self):\n  pass\n",
      "pkg/foo.py",
    );
    expect(r.functions).toContainEqual(
      expect.objectContaining({ qualifiedName: "foo" }),
    );
  });

  it("extracts decorated method inside a class with ClassName.method name", () => {
    const r = adapter.extractFile(
      "class Model:\n  @property\n  def name(self):\n    pass\n",
      "pkg/models.py",
    );
    expect(r.functions).toContainEqual(
      expect.objectContaining({ qualifiedName: "Model.name" }),
    );
  });

  it("returns empty result for empty file without throwing", () => {
    expect(() => adapter.extractFile("", "pkg/empty.py")).not.toThrow();
    expect(adapter.extractFile("", "pkg/empty.py").functions).toEqual([]);
  });
});

describe("python adapter — call extraction", () => {
  it("extracts plain call inside a function", () => {
    const r = adapter.extractFile("def foo():\n  bar()\n", "pkg/foo.py");
    expect(r.rawCalls).toContainEqual({
      callerQualifiedName: "foo",
      callerFile: "pkg/foo.py",
      rawCallee: "bar",
      kind: "call",
    });
  });

  it("maps self.method() to ClassName.method", () => {
    const r = adapter.extractFile(
      "class Model:\n  def save(self):\n    self.finalize()\n",
      "pkg/models.py",
    );
    expect(r.rawCalls).toContainEqual({
      callerQualifiedName: "Model.save",
      callerFile: "pkg/models.py",
      rawCallee: "Model.finalize",
      kind: "method",
    });
  });

  it("maps cls.method() to ClassName.method", () => {
    const r = adapter.extractFile(
      "class Model:\n  @classmethod\n  def create(cls):\n    cls.validate()\n",
      "pkg/models.py",
    );
    expect(r.rawCalls).toContainEqual(
      expect.objectContaining({ rawCallee: "Model.validate", kind: "method" }),
    );
  });

  it("emits obj.method passthrough for non-self attribute calls", () => {
    const r = adapter.extractFile("def foo():\n  obj.bar()\n", "pkg/foo.py");
    expect(r.rawCalls).toContainEqual(
      expect.objectContaining({ rawCallee: "obj.bar", kind: "method" }),
    );
  });
});

describe("python adapter — import bindings", () => {
  it("extracts named import from relative module — candidate is repo-root-relative", () => {
    const r = adapter.extractFile(
      "from .utils import helper\ndef foo(): pass\n",
      "mypackage/models.py",
    );
    expect(r.importBindings).toContainEqual({
      localName: "helper",
      importedName: "helper",
      fromSpecifier: "mypackage/utils",
      bindingKind: "named",
    });
  });

  it("extracts aliased import", () => {
    const r = adapter.extractFile(
      "from .utils import helper as h\ndef foo(): pass\n",
      "mypackage/models.py",
    );
    expect(r.importBindings).toContainEqual({
      localName: "h",
      importedName: "helper",
      fromSpecifier: "mypackage/utils",
      bindingKind: "named",
    });
  });

  it("extracts named import from absolute module — dots converted to slashes", () => {
    const r = adapter.extractFile(
      "from mypackage.utils import helper\ndef foo(): pass\n",
      "main.py",
    );
    expect(r.importBindings).toContainEqual({
      localName: "helper",
      importedName: "helper",
      fromSpecifier: "mypackage/utils",
      bindingKind: "named",
    });
  });

  it("extracts namespace import (import X as Y)", () => {
    const r = adapter.extractFile(
      "import mypackage.utils as utils\ndef foo(): pass\n",
      "main.py",
    );
    expect(r.importBindings).toContainEqual({
      localName: "utils",
      importedName: "utils",
      fromSpecifier: "mypackage/utils",
      bindingKind: "namespace",
    });
  });
});
