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
