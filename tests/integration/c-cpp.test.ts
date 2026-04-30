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
