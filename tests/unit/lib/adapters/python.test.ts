import { describe, it, expect, beforeAll } from "vitest";
import { createPythonAdapter } from "../../../../src/lib/adapters/python.js";
import type { LanguageAdapter } from "../../../../src/lib/lang-adapter.js";

let adapter: LanguageAdapter;

beforeAll(async () => {
	adapter = await createPythonAdapter();
});

describe("python adapter — function extraction", () => {
	it("extracts module-level def as exported", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"pkg/foo.py",
			"def foo():\n  pass\n",
		);
		expect(r.functions).toContainEqual(
			expect.objectContaining({
				qualifiedName: "foo",
				file: "pkg/foo.py",
				exported: true,
				isDefaultExport: false,
			}),
		);
	});

	it("extracts async def", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"pkg/foo.py",
			"async def bar():\n  pass\n",
		);
		expect(r.functions).toContainEqual(
			expect.objectContaining({ qualifiedName: "bar", exported: true }),
		);
	});

	it("extracts class method with ClassName.method qualified name", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"pkg/models.py",
			"class Model:\n  def save(self):\n    pass\n  def finalize(self):\n    pass\n",
		);
		expect(r.functions).toContainEqual(
			expect.objectContaining({ qualifiedName: "Model.save" }),
		);
		expect(r.functions).toContainEqual(
			expect.objectContaining({ qualifiedName: "Model.finalize" }),
		);
	});

	it("extracts decorated function", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"pkg/foo.py",
			"@property\ndef foo(self):\n  pass\n",
		);
		expect(r.functions).toContainEqual(
			expect.objectContaining({ qualifiedName: "foo" }),
		);
	});

	it("extracts decorated method inside a class with ClassName.method name", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"pkg/models.py",
			"class Model:\n  @property\n  def name(self):\n    pass\n",
		);
		expect(r.functions).toContainEqual(
			expect.objectContaining({ qualifiedName: "Model.name" }),
		);
	});

	it("returns empty result for empty file without throwing", async () => {
		const result = await adapter.extractCallGraph!("", "pkg/empty.py", "");
		expect(result.functions).toEqual([]);
	});
});

describe("python adapter — call extraction", () => {
	it("extracts plain call inside a function", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"pkg/foo.py",
			"def foo():\n  bar()\n",
		);
		expect(r.rawCalls).toContainEqual({
			callerQualifiedName: "foo",
			callerFile: "pkg/foo.py",
			rawCallee: "bar",
			kind: "call",
		});
	});

	it("maps self.method() to ClassName.method", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"pkg/models.py",
			"class Model:\n  def save(self):\n    self.finalize()\n",
		);
		expect(r.rawCalls).toContainEqual({
			callerQualifiedName: "Model.save",
			callerFile: "pkg/models.py",
			rawCallee: "Model.finalize",
			kind: "method",
		});
	});

	it("maps cls.method() to ClassName.method", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"pkg/models.py",
			"class Model:\n  @classmethod\n  def create(cls):\n    cls.validate()\n",
		);
		expect(r.rawCalls).toContainEqual(
			expect.objectContaining({ rawCallee: "Model.validate", kind: "method" }),
		);
	});

	it("emits obj.method passthrough for non-self attribute calls", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"pkg/foo.py",
			"def foo():\n  obj.bar()\n",
		);
		expect(r.rawCalls).toContainEqual(
			expect.objectContaining({ rawCallee: "obj.bar", kind: "method" }),
		);
	});
});

describe("python adapter — import bindings", () => {
	it("extracts named import from relative module — candidate is repo-root-relative", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"mypackage/models.py",
			"from .utils import helper\ndef foo(): pass\n",
		);
		expect(r.importBindings).toContainEqual({
			localName: "helper",
			importedName: "helper",
			fromSpecifier: "mypackage/utils",
			bindingKind: "named",
		});
	});

	it("extracts aliased import", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"mypackage/models.py",
			"from .utils import helper as h\ndef foo(): pass\n",
		);
		expect(r.importBindings).toContainEqual({
			localName: "h",
			importedName: "helper",
			fromSpecifier: "mypackage/utils",
			bindingKind: "named",
		});
	});

	it("extracts named import from absolute module — dots converted to slashes", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"main.py",
			"from mypackage.utils import helper\ndef foo(): pass\n",
		);
		expect(r.importBindings).toContainEqual({
			localName: "helper",
			importedName: "helper",
			fromSpecifier: "mypackage/utils",
			bindingKind: "named",
		});
	});

	it("extracts namespace import (import X as Y)", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"main.py",
			"import mypackage.utils as utils\ndef foo(): pass\n",
		);
		expect(r.importBindings).toContainEqual({
			localName: "utils",
			importedName: "utils",
			fromSpecifier: "mypackage/utils",
			bindingKind: "namespace",
		});
	});
});

describe("python adapter — nested def call suppression", () => {
	it("produces no call edge attributed to an inner (nested) function", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"pkg/foo.py",
			"def outer():\n  def inner():\n    helper()\n",
		);
		const phantomEdge = r.rawCalls.find(
			(c) => c.callerQualifiedName === "inner",
		);
		expect(phantomEdge).toBeUndefined();
	});

	it("still emits edges for the outer function's own direct calls", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"pkg/foo.py",
			"def outer():\n  helper()\n  def inner():\n    other()\n",
		);
		expect(r.rawCalls).toContainEqual(
			expect.objectContaining({
				callerQualifiedName: "outer",
				rawCallee: "helper",
			}),
		);
		const phantom = r.rawCalls.find((c) => c.callerQualifiedName === "inner");
		expect(phantom).toBeUndefined();
	});

	it("produces no edge for a nested def inside a class method", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"pkg/models.py",
			"class Model:\n  def save(self):\n    def _inner():\n      helper()\n",
		);
		// Phantom edge could be attributed as "_inner" or "Model._inner" depending on
		// how far up the walk goes before finding a class; both are wrong since _inner
		// has no FunctionNode.
		const phantom = r.rawCalls.find(
			(c) =>
				c.callerQualifiedName === "_inner" ||
				c.callerQualifiedName === "Model._inner",
		);
		expect(phantom).toBeUndefined();
	});
});

describe("python adapter — import site extraction", () => {
	it("extracts relative import site as repo-root-relative candidate", async () => {
		const sites = await adapter.extractImports(
			"",
			"mypackage/models.py",
			"from .utils import helper\n",
		);
		expect(sites).toContainEqual(
			expect.objectContaining({
				from: "mypackage/models.py",
				candidate: "mypackage/utils",
			}),
		);
	});

	it("extracts double-dot relative import site", async () => {
		const sites = await adapter.extractImports(
			"",
			"mypackage/sub/models.py",
			"from ..base import Thing\n",
		);
		expect(sites).toContainEqual(
			expect.objectContaining({ candidate: "mypackage/base" }),
		);
	});

	it("extracts absolute import site as slash-separated candidate", async () => {
		const sites = await adapter.extractImports(
			"",
			"main.py",
			"from mypackage.utils import helper\n",
		);
		expect(sites).toContainEqual(
			expect.objectContaining({ candidate: "mypackage/utils" }),
		);
	});

	it("extracts plain import statement as slash-separated candidate", async () => {
		const sites = await adapter.extractImports(
			"",
			"main.py",
			"import os.path\n",
		);
		expect(sites).toContainEqual(
			expect.objectContaining({ candidate: "os/path" }),
		);
	});

	it("returns empty array for empty file without throwing", async () => {
		const sites = await adapter.extractImports("", "pkg/empty.py", "");
		expect(sites).toEqual([]);
	});
});
