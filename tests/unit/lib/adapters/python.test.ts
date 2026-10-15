import { describe, it, expect, beforeAll } from "vitest";
import { createPythonAdapter } from "../../../../src/lib/adapters/python.js";
import { functionsFromSymbols } from "../../../../src/lib/symbols.js";
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
		expect(functionsFromSymbols(r.symbols)).toContainEqual(
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
		expect(functionsFromSymbols(r.symbols)).toContainEqual(
			expect.objectContaining({ qualifiedName: "bar", exported: true }),
		);
	});

	it("extracts class method with ClassName.method qualified name", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"pkg/models.py",
			"class Model:\n  def save(self):\n    pass\n  def finalize(self):\n    pass\n",
		);
		expect(functionsFromSymbols(r.symbols)).toContainEqual(
			expect.objectContaining({ qualifiedName: "Model.save" }),
		);
		expect(functionsFromSymbols(r.symbols)).toContainEqual(
			expect.objectContaining({ qualifiedName: "Model.finalize" }),
		);
	});

	it("extracts decorated function", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"pkg/foo.py",
			"@property\ndef foo(self):\n  pass\n",
		);
		expect(functionsFromSymbols(r.symbols)).toContainEqual(
			expect.objectContaining({ qualifiedName: "foo" }),
		);
	});

	it("extracts decorated method inside a class with ClassName.method name", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"pkg/models.py",
			"class Model:\n  @property\n  def name(self):\n    pass\n",
		);
		expect(functionsFromSymbols(r.symbols)).toContainEqual(
			expect.objectContaining({ qualifiedName: "Model.name" }),
		);
	});

	it("returns empty result for empty file without throwing", async () => {
		const result = await adapter.extractCallGraph!("", "pkg/empty.py", "");
		expect(functionsFromSymbols(result.symbols)).toEqual([]);
	});
});

describe("python adapter — call extraction", () => {
	it("extracts plain call inside a function", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"pkg/foo.py",
			"def foo():\n  bar()\n",
		);
		expect(r.rawCalls).toContainEqual(
			expect.objectContaining({
				callerQualifiedName: "foo",
				callerFile: "pkg/foo.py",
				rawCallee: "bar",
				kind: "call",
			}),
		);
	});

	it("keeps self.method() as self.method with enclosingClass", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"pkg/models.py",
			"class Model:\n  def save(self):\n    self.finalize()\n",
		);
		expect(r.rawCalls).toContainEqual(
			expect.objectContaining({
				callerQualifiedName: "Model.save",
				callerFile: "pkg/models.py",
				rawCallee: "self.finalize",
				kind: "method",
			}),
		);
	});

	it("keeps cls.method() as cls.method", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"pkg/models.py",
			"class Model:\n  @classmethod\n  def create(cls):\n    cls.validate()\n",
		);
		expect(r.rawCalls).toContainEqual(
			expect.objectContaining({ rawCallee: "cls.validate", kind: "method" }),
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

describe("python adapter — range and site emission (unit)", () => {
	it("populates column/endLine/endColumn on a multi-line function", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"pkg/r.py",
			"def multi():\n    return 1\n",
		);
		const fn = functionsFromSymbols(r.symbols).find((f) => f.qualifiedName === "multi");
		expect(fn?.column).toBe(1);
		expect(fn?.endLine).toBeGreaterThan(fn!.line);
		expect(fn?.endColumn).toBeGreaterThanOrEqual(1);
	});

	it("populates site on a plain call", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"pkg/c.py",
			"def caller():\n    callee()\n",
		);
		const call = r.rawCalls.find(
			(c) => c.rawCallee === "callee" && c.kind === "call",
		);
		expect(call?.site).toBeDefined();
		expect(call?.site?.line).toBe(2);
	});

	it("populates site on a self.method() method call", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"pkg/m.py",
			"class C:\n    def save(self):\n        self.finalize()\n",
		);
		const method = r.rawCalls.find((c) => c.kind === "method");
		expect(method?.site).toBeDefined();
	});
});

describe("python adapter: symbols and refs (3.2)", () => {
	it("emits class, method, function, module variable with '.' containers and name ranges", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"pkg/m.py",
			["class Model(Base):", "  def save(self):", "    self.flush()", "", "def helper():", "  pass", "", "LIMIT = 3", "x, y = 1, 2"].join("\n"),
		);
		const byQn = Object.fromEntries(r.symbols!.map((s) => [s.qualifiedName, s]));
		expect(byQn.Model).toMatchObject({ kind: "class", name: "Model", exported: true });
		expect(byQn["Model.save"]).toMatchObject({ kind: "method", name: "save", containerQualifiedName: "Model" });
		expect(byQn.helper).toMatchObject({ kind: "function" });
		expect(byQn.LIMIT).toMatchObject({ kind: "variable", name: "LIMIT" });
		expect(byQn.x).toMatchObject({ kind: "variable" });
		expect(byQn.y).toMatchObject({ kind: "variable" });
		expect(byQn.Model.nameRange).toEqual({ line: 1, column: 7, endLine: 1, endColumn: 11 });
		expect(functionsFromSymbols(r.symbols)).toEqual((await import("../../../../src/lib/symbols.js")).functionsFromSymbols(r.symbols!));
	});

	it("emits call refs with receiver, extends refs, and import refs; self-calls carry enclosingClass", async () => {
		const r = await adapter.extractCallGraph!(
			"",
			"pkg/m.py",
			["from .utils import helper as h, other", "import os.path as osp", "class Model(Base):", "  def save(self):", "    self.flush()", "    h()", "    osp.join('a')"].join("\n"),
		);
		const refs = r.rawRefs!;
		const imports = refs.filter((x) => x.kind === "import").map((x) => [x.name, x.alias, x.specifier, x.importKind]);
		expect(imports).toEqual([
			["helper", "h", "pkg/utils", "named"],
			["other", undefined, "pkg/utils", "named"],
			["osp", undefined, "os/path", "namespace"],
		]);
		expect(refs.filter((x) => x.kind === "extends").map((x) => x.name)).toEqual(["Base"]);
		const calls = refs.filter((x) => x.kind === "call");
		expect(calls.map((c) => [c.name, c.receiver, c.enclosingClass, c.enclosingQualifiedName])).toEqual([
			["flush", "self", "Model", "Model.save"],
			["h", undefined, "Model", "Model.save"],
			["join", "osp", "Model", "Model.save"],
		]);
		const selfCall = r.rawCalls.find((c) => c.rawCallee === "self.flush")!;
		expect(selfCall.enclosingClass).toBe("Model");
		expect(selfCall.kind).toBe("method");
	});

	it("does not emit nested function or local variables as symbols", async () => {
		const r = await adapter.extractCallGraph!("", "pkg/m.py", "def outer():\n  local = 1\n  def inner():\n    pass\n");
		expect(r.symbols!.map((s) => s.qualifiedName)).toEqual(["outer"]);
	});

	it("uses the full dotted class chain for nested classes in symbols, calls, and refs", async () => {
		const r = await adapter.extractCallGraph!("", "pkg/m.py", "class Outer:\n  class Inner:\n    def m(self):\n      self.n()\n");
		const qns = r.symbols!.map((s) => s.qualifiedName);
		expect(qns).toContain("Outer.Inner.m");
		const call = r.rawCalls.find((c) => c.rawCallee === "self.n")!;
		expect(call.callerQualifiedName).toBe("Outer.Inner.m");
		expect(call.enclosingClass).toBe("Outer.Inner");
		const ref = r.rawRefs!.find((x) => x.kind === "call" && x.name === "n")!;
		expect(ref.enclosingQualifiedName).toBe("Outer.Inner.m");
		expect(ref.enclosingClass).toBe("Outer.Inner");
	});
});
