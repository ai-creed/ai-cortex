// tests/integration/suggest-with-memory-surface.test.ts
//
// End-to-end verification that the memory-surfacing wiring composes correctly
// through the actual library + MCP-helper boundary.
//
// Strategy: library-level approach (suggestRepo() + attachRelatedMemories()) —
// avoids spinning up the full MCP server and tests the same code path.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { suggestRepo } from "../../src/lib/suggest.js";
import { attachRelatedMemories } from "../../src/mcp/server.js";
import { openLifecycle, createMemory } from "../../src/lib/memory/lifecycle.js";
import { resolveRepoIdentity } from "../../src/lib/repo-identity.js";

// ---------------------------------------------------------------------------
// Deterministic embed mock — same pattern as surface.test.ts (Task 6).
// ---------------------------------------------------------------------------
let nextVec: Float32Array | null = null;

vi.mock("../../src/lib/embed-provider.js", () => ({
	MODEL_NAME: "Xenova/all-MiniLM-L6-v2",
	EMBEDDING_DIM: 384,
	getProvider: vi.fn(async () => ({
		embed: async (texts: string[]) => {
			const v = nextVec ?? new Float32Array(384);
			return texts.map(() => v);
		},
	})),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A vector with positive values on every dimension — cosine = 1 against itself. */
function fakeTaskVec(): Float32Array {
	const v = new Float32Array(384);
	for (let i = 0; i < 384; i++) v[i] = (i % 7) / 7;
	return v;
}

function initFixtureRepo(repoPath: string): void {
	// Create a file under the glob-target path
	const dir = path.join(repoPath, "MainApp", "lib", "cards");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "card.ts"),
		"// card component\nexport function getCard(id: string) { return { id }; }\n",
	);
	execFileSync("git", ["init", "-q"], { cwd: repoPath });
	execFileSync("git", ["-C", repoPath, "config", "user.email", "t@t"]);
	execFileSync("git", ["-C", repoPath, "config", "user.name", "t"]);
	execFileSync("git", ["-C", repoPath, "config", "commit.gpgsign", "false"]);
	execFileSync("git", ["add", "-A"], { cwd: repoPath });
	execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoPath });
}

// ---------------------------------------------------------------------------
// Fixture setup / teardown
// ---------------------------------------------------------------------------

let cacheHome: string;
let repoPath: string;
let repoKey: string;

beforeEach(() => {
	// Resolve realpaths to avoid macOS /var → /private/var symlink mismatches
	cacheHome = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-suggest-mem-")),
	);
	process.env.AI_CORTEX_CACHE_HOME = cacheHome;

	repoPath = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-suggest-repo-")),
	);
	initFixtureRepo(repoPath);

	// Derive the repoKey the same way the library does.
	repoKey = resolveRepoIdentity(repoPath).repoKey;
	nextVec = null;
});

afterEach(() => {
	delete process.env.AI_CORTEX_CACHE_HOME;
	fs.rmSync(cacheHome, { recursive: true, force: true });
	fs.rmSync(repoPath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("suggest + attachRelatedMemories — glob-scope surfacing (E2E)", () => {
	it("surfaces a glob-scoped memory that matches the result file window", async () => {
		// Seed a memory with a glob scope that covers the fixture file.
		const tv = fakeTaskVec();
		nextVec = tv;
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		let memoryId: string;
		try {
			memoryId = await createMemory(lc, {
				type: "decision",
				title: "Card module convention",
				body: "Cards must export a typed getCard() helper.",
				scope: { files: ["MainApp/**/*card*"], tags: [] },
				source: "explicit",
			});
		} finally {
			lc.close();
		}

		// suggestRepo call — the mock embed returns tv for the task too.
		nextVec = tv;
		const suggestResult = await suggestRepo(repoPath, "card detail", {
			mode: "deep",
		});
		expect(suggestResult.results.length).toBeGreaterThan(0);

		// Attach memories through the MCP-helper.
		nextVec = tv;
		const withMemories = await attachRelatedMemories(
			suggestResult,
			"card detail",
			repoKey,
		);

		// Core assertions
		expect(withMemories).toHaveProperty("relatedMemories");
		const related = withMemories.relatedMemories as Array<{
			id: string;
			track: string;
			matchScores: { fileOverlap: string[]; task: number };
		}>;
		expect(Array.isArray(related)).toBe(true);
		expect(related.length).toBeGreaterThan(0);

		const hit = related.find((r) => r.id === memoryId);
		expect(hit).toBeDefined();
		expect(hit!.track).toBe("scoped");
		// fileOverlap holds the matched WINDOW path, not the stored glob pattern.
		expect(hit!.matchScores.fileOverlap).toContain("MainApp/lib/cards/card.ts");
		// task cosine is within [0, 1].
		expect(hit!.matchScores.task).toBeGreaterThanOrEqual(0);
		expect(hit!.matchScores.task).toBeLessThanOrEqual(1);
	});

	it("returns result unchanged when no memory's scope matches the file window", async () => {
		// Seed a memory whose scope does NOT match the fixture file path.
		const tv = fakeTaskVec();
		nextVec = tv;
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			await createMemory(lc, {
				type: "decision",
				title: "Unrelated module convention",
				body: "Some rule for a completely different area.",
				scope: { files: ["OtherApp/completely/different/**"], tags: [] },
				source: "explicit",
			});
		} finally {
			lc.close();
		}

		nextVec = tv;
		const suggestResult = await suggestRepo(repoPath, "card detail", {
			mode: "deep",
		});

		nextVec = tv;
		const withMemories = await attachRelatedMemories(
			suggestResult,
			"card detail",
			repoKey,
		);

		// No match → result returned unchanged without relatedMemories.
		expect(withMemories).not.toHaveProperty("relatedMemories");
	});

	it("returns the file response intact when the vector sidecar is corrupted", async () => {
		// Seed a memory then delete its vector sidecar.
		const tv = fakeTaskVec();
		nextVec = tv;
		const lc = await openLifecycle(repoKey, { agentId: "test" });
		try {
			await createMemory(lc, {
				type: "decision",
				title: "Card module convention",
				body: "Cards must export a typed getCard() helper.",
				scope: { files: ["MainApp/**/*card*"], tags: [] },
				source: "explicit",
			});
		} finally {
			lc.close();
		}

		// Corrupt the sidecar so vector lookup fails.
		const sidecarBin = path.join(cacheHome, repoKey, "memory", ".vectors.bin");
		fs.rmSync(sidecarBin, { force: true });

		nextVec = tv;
		const suggestResult = await suggestRepo(repoPath, "card detail", {
			mode: "deep",
		});
		expect(suggestResult.results.length).toBeGreaterThan(0);

		nextVec = tv;
		const withMemories = await attachRelatedMemories(
			suggestResult,
			"card detail",
			repoKey,
		);

		// The try/catch in attachRelatedMemories must swallow the error.
		// The file results must still be present.
		expect(withMemories.results.length).toBeGreaterThan(0);
		// relatedMemories should be absent (no match or swallowed error).
		expect(withMemories).not.toHaveProperty("relatedMemories");
	});
});
