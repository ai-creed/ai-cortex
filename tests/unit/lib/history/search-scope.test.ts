import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSession } from "../../../../src/lib/history/store.js";
import { searchHistory } from "../../../../src/lib/history/search.js";
import { HISTORY_SCHEMA_VERSION } from "../../../../src/lib/history/types.js";
import type { SessionRecord } from "../../../../src/lib/history/types.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(
		path.join(os.tmpdir(), "ai-cortex-history-search-scope-"),
	);
	vi.spyOn(os, "homedir").mockReturnValue(tmp);
	delete process.env.AI_CORTEX_SESSION_ID;
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

function rec(id: string, prompt: string): SessionRecord {
	return {
		version: HISTORY_SCHEMA_VERSION,
		id,
		startedAt: "x",
		endedAt: null,
		turnCount: 1,
		lastProcessedTurn: 0,
		hasSummary: false,
		hasRaw: false,
		rawDroppedAt: null,
		transcriptPath: "",
		summary: "",
		evidence: {
			toolCalls: [],
			filePaths: [],
			userPrompts: [{ turn: 0, text: prompt }],
			corrections: [],
		},
		chunks: [],
	};
}

describe("searchHistory (scope)", () => {
	it("scope=session uses sessionId override", async () => {
		await writeSession("REPO", rec("a", "alpha here"));
		await writeSession("REPO", rec("b", "beta here"));
		const result = await searchHistory({
			repoKey: "REPO",
			cwd: "/tmp/x",
			query: "beta",
			sessionId: "b",
			scope: "session",
		});
		expect(result.broadened).toBe(false);
		expect(result.hits.every((h) => h.sessionId === "b")).toBe(true);
	});

	it("scope=session resolves current session via env var", async () => {
		process.env.AI_CORTEX_SESSION_ID = "a";
		await writeSession("REPO", rec("a", "alpha here"));
		await writeSession("REPO", rec("b", "beta here"));
		const result = await searchHistory({
			repoKey: "REPO",
			cwd: "/tmp/x",
			query: "alpha",
			scope: "session",
		});
		expect(result.broadened).toBe(false);
		expect(result.hits.every((h) => h.sessionId === "a")).toBe(true);
	});

	it("scope=session with empty hits auto-broadens to project", async () => {
		process.env.AI_CORTEX_SESSION_ID = "a";
		await writeSession("REPO", rec("a", "alpha here"));
		await writeSession("REPO", rec("b", "beta in another session"));
		const result = await searchHistory({
			repoKey: "REPO",
			cwd: "/tmp/x",
			query: "beta",
			scope: "session",
		});
		expect(result.broadened).toBe(true);
		expect(result.hits.some((h) => h.sessionId === "b")).toBe(true);
	});

	it("scope=session and detection fails returns error", async () => {
		await writeSession("REPO", rec("a", "alpha"));
		const result = await searchHistory({
			repoKey: "REPO",
			cwd: "/tmp/x",
			query: "alpha",
			scope: "session",
		});
		expect(result.error).toBe("session-not-detected");
	});

	it("scope=project searches all sessions, no broaden marker", async () => {
		await writeSession("REPO", rec("a", "alpha"));
		await writeSession("REPO", rec("b", "beta"));
		const result = await searchHistory({
			repoKey: "REPO",
			cwd: "/tmp/x",
			query: "alpha",
			scope: "project",
		});
		expect(result.broadened).toBe(false);
		expect(result.hits.length).toBeGreaterThan(0);
	});
});
