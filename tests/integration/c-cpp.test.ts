import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	ensureAdapters,
	resetEnsureAdapters,
} from "../../src/lib/adapters/ensure.js";
import { extractCallGraph } from "../../src/lib/call-graph.js";
import { extractImports } from "../../src/lib/import-graph.js";
import { buildIndex, buildIncrementalIndex } from "../../src/lib/indexer.js";
import { resolveRepoIdentity } from "../../src/lib/repo-identity.js";
import type { FunctionNode } from "../../src/lib/models.js";

const FIXTURE = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"../fixtures/c-cpp-mixed",
);

const FILES = ["src/utils.h", "src/utils.cpp", "src/main.cpp", "src/main.ts"];

let tmpDir: string;

beforeAll(async () => {
	resetEnsureAdapters();
	await ensureAdapters();

	// Create a temp git repo with the fixture files so buildIndex/buildIncrementalIndex
	// can call git commands (fingerprint, ls-files, etc.)
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-ccpp-incr-"));
	execFileSync("git", ["init", tmpDir]);
	execFileSync("git", ["-C", tmpDir, "config", "user.email", "test@test.com"]);
	execFileSync("git", ["-C", tmpDir, "config", "user.name", "Test"]);
	execFileSync("git", ["-C", tmpDir, "config", "commit.gpgsign", "false"]);

	fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
	for (const file of FILES) {
		fs.copyFileSync(path.join(FIXTURE, file), path.join(tmpDir, file));
	}

	execFileSync("git", ["-C", tmpDir, "add", "."]);
	execFileSync("git", ["-C", tmpDir, "commit", "-m", "init"]);
});

afterAll(() => {
	if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("C/C++ + TS mixed indexing", () => {
	it("emits FunctionNode ranges and RawCallSite.site for C/C++", async () => {
		const { functions, calls } = await extractCallGraph(FIXTURE, FILES);
		const def = functions.find(
			(f) => !f.isDeclarationOnly && f.endLine && f.endLine > f.line,
		);
		expect(def).toBeDefined();
		expect(def?.column).toBeGreaterThanOrEqual(1);
		expect(def?.endColumn).toBeGreaterThanOrEqual(1);

		const cppCall = calls.find((c) => c.site);
		expect(cppCall?.site?.line).toBeGreaterThanOrEqual(1);
	});

	it("never emits the reserved FunctionNode.id key at v3.1 (c/c++)", async () => {
		const { functions } = await extractCallGraph(FIXTURE, FILES);
		for (const fn of functions) {
			expect(Object.prototype.hasOwnProperty.call(fn, "id")).toBe(false);
		}
	});

	it("extracts functions from all files", async () => {
		const { functions } = await extractCallGraph(FIXTURE, FILES);
		const names = functions.map((f) => f.qualifiedName);
		expect(names).toContain("add");
		expect(names).toContain("main");
		expect(names).toContain("tsEntry");
	});

	it("marks utils.h add() as declaration-only", async () => {
		const { functions } = await extractCallGraph(FIXTURE, FILES);
		const headerDecl = functions.find(
			(f) => f.qualifiedName === "add" && f.file === "src/utils.h",
		);
		expect(headerDecl).toBeDefined();
		expect(headerDecl?.isDeclarationOnly).toBe(true);
	});

	it("marks utils.cpp add() as live definition", async () => {
		const { functions } = await extractCallGraph(FIXTURE, FILES);
		const def = functions.find(
			(f) => f.qualifiedName === "add" && f.file === "src/utils.cpp",
		);
		expect(def).toBeDefined();
		expect(def?.isDeclarationOnly).toBeFalsy();
	});

	it("resolves main.cpp::main -> utils.cpp::add via repo-wide fallback", async () => {
		const { calls } = await extractCallGraph(FIXTURE, FILES);
		expect(calls).toContainEqual(
			expect.objectContaining({
				from: "src/main.cpp::main",
				to: "src/utils.cpp::add",
				kind: "call",
			}),
		);
	});

	it("extracts #include edges for main.cpp", async () => {
		const imports = await extractImports(FIXTURE, FILES, FILES);
		const mainIncludes = imports.filter((e) => e.from === "src/main.cpp");
		expect(mainIncludes.some((e) => e.to === "src/utils.h")).toBe(true);
	});
});

describe("C/C++ incremental reindex", () => {
	it("re-indexes a changed .cpp file and preserves call edges", async () => {
		const identity = resolveRepoIdentity(tmpDir);

		// Step 1: Build initial full index
		const initial = await buildIndex(identity);

		// Verify initial index has the call edge
		expect(initial.calls).toContainEqual(
			expect.objectContaining({
				from: "src/main.cpp::main",
				to: "src/utils.cpp::add",
				kind: "call",
			}),
		);

		// Step 2: Simulate utils.cpp change (same content — just testing the incremental path)
		const diff = {
			changed: ["src/utils.cpp"],
			removed: [] as string[],
			method: "hash-compare" as const,
		};

		// Step 3: Call incremental reindex
		const updated = await buildIncrementalIndex(identity, initial, diff, false);

		// Step 4: Verify the call edge still exists after reindex
		expect(updated.calls).toContainEqual(
			expect.objectContaining({
				from: "src/main.cpp::main",
				to: "src/utils.cpp::add",
				kind: "call",
			}),
		);

		// And functions still present
		const names = updated.functions.map((f: FunctionNode) => f.qualifiedName);
		expect(names).toContain("add");
	});
});

describe("C++ namespaced cross-file calls", () => {
	it("resolves ns::add() through the included header to the definition", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-ccpp-ns-"));
		try {
			fs.mkdirSync(path.join(dir, "src"), { recursive: true });
			fs.writeFileSync(path.join(dir, "src/util.h"), "namespace ns { int add(int a, int b); }\n");
			fs.writeFileSync(path.join(dir, "src/util.cpp"), '#include "util.h"\nnamespace ns { int add(int a, int b) { return a + b; } }\n');
			fs.writeFileSync(path.join(dir, "src/main.cpp"), '#include "util.h"\nint main() { return ns::add(1, 2); }\n');
			const { calls } = await extractCallGraph(dir, ["src/util.h", "src/util.cpp", "src/main.cpp"]);
			const edge = calls.find((c) => c.from === "src/main.cpp::main");
			expect(edge?.to).toBe("src/util.cpp::ns.add");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("C-family refs share the calls resolution rules (Ruling 13)", () => {
	it("gives the refs row the same to_key as the calls row for same-file ns::add, header ns::add, and helper() via util.h", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-ccpp-refs-"));
		try {
			fs.mkdirSync(path.join(dir, "src"), { recursive: true });
			fs.writeFileSync(path.join(dir, "src/util.h"), "int helper(int x);\nnamespace hs { int mul(int a, int b); }\n");
			fs.writeFileSync(path.join(dir, "src/util.c"), '#include "util.h"\nint helper(int x) { return x + 1; }\n');
			fs.writeFileSync(path.join(dir, "src/mul.cpp"), '#include "util.h"\nnamespace hs { int mul(int a, int b) { return a * b; } }\n');
			fs.writeFileSync(
				path.join(dir, "src/main.cpp"),
				'#include "util.h"\nnamespace ns { int add(int a) { return a; } }\nint main() { return ns::add(1) + helper(2) + hs::mul(3, 4); }\n',
			);
			const { calls, refs } = await extractCallGraph(dir, ["src/util.h", "src/util.c", "src/mul.cpp", "src/main.cpp"]);
			const callTo = (line: number, col: number) =>
				calls.find((c) => c.from === "src/main.cpp::main" && c.site?.line === line && c.site?.column === col)?.to;
			const refFor = (name: string) => refs.find((r) => r.file === "src/main.cpp" && r.name === name && r.kind === "call");
			const cases: Array<[string, string]> = [
				["add", "src/main.cpp::ns.add"],
				["helper", "src/util.c::helper"],
				["mul", "src/mul.cpp::hs.mul"],
			];
			for (const [name, key] of cases) {
				const ref = refFor(name);
				expect(ref?.to, name).toBe(key);
				const call = calls.find((c) => c.from === "src/main.cpp::main" && c.to === key);
				expect(call, name).toBeDefined();
				expect(callTo(call!.site!.line, call!.site!.column), name).toBe(ref!.to);
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

