import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoKey = "6261636b66696c63"; // "backfilc" + pad to 16 hex

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stats-backfill-cli-"));
	// Seed one session with a known mix of cortex + non-cortex tool calls.
	const sessionDir = path.join(tmp, repoKey, "history", "sessions", "s1");
	fs.mkdirSync(sessionDir, { recursive: true });
	fs.writeFileSync(
		path.join(sessionDir, "session.json"),
		JSON.stringify({
			version: 2,
			id: "s1",
			startedAt: "2026-05-14T08:00:00.000Z",
			endedAt: null,
			turnCount: 0,
			lastProcessedTurn: 0,
			hasSummary: false,
			hasRaw: false,
			rawDroppedAt: null,
			transcriptPath: "",
			summary: "",
			evidence: {
				toolCalls: [
					{ turn: 1, name: "recall_memory", args: "x" },
					{ turn: 2, name: "Read", args: "/y" },
					{ turn: 3, name: "suggest_files", args: "z" },
				],
				filePaths: [],
				userPrompts: [],
				corrections: [],
			},
			chunks: [],
		}),
		"utf8",
	);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("ai-cortex stats backfill CLI", () => {
	it("processes one repo and prints a per-repo line + totals", () => {
		const cli = path.resolve(__dirname, "../../src/cli.ts");
		const result = spawnSync("pnpm", ["tsx", cli, "stats", "backfill"], {
			encoding: "utf8",
			timeout: 30_000,
			env: { ...process.env, AI_CORTEX_CACHE_HOME: tmp },
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/1 sessions, 2 rows inserted, 1 non-cortex skipped/);
		expect(result.stdout).toMatch(/Total: 1 repos, 1 sessions, 2 rows inserted/);
	});
});
