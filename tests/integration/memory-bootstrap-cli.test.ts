import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeSession } from "../../src/lib/history/store.js";
import { mkRepoKey, cleanupRepo } from "../helpers/memory-fixtures.js";
import type { SessionRecord } from "../../src/lib/history/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../../dist/src/cli.js");

function mkSession(id: string): SessionRecord {
	return {
		version: 2,
		id,
		startedAt: "2026-04-30T00:00:00Z",
		endedAt: "2026-04-30T01:00:00Z",
		turnCount: 1,
		lastProcessedTurn: 1,
		hasSummary: false,
		hasRaw: true,
		rawDroppedAt: null,
		transcriptPath: "/tmp/x",
		summary: "",
		evidence: {
			toolCalls: [],
			filePaths: [],
			userPrompts: [],
			corrections: [
				{ turn: 1, text: "always run pnpm typecheck before commit" },
			],
		},
		chunks: [],
	};
}

describe("ai-cortex memory bootstrap (cli)", () => {
	let repoKey: string;
	beforeEach(async () => {
		repoKey = await mkRepoKey("bootstrap-cli");
	});
	afterEach(async () => {
		await cleanupRepo(repoKey);
	});

	it("exits 0 and prints a summary", async () => {
		await writeSession(repoKey, mkSession("s-1"));
		const res = spawnSync(
			"node",
			[
				CLI,
				"memory",
				"bootstrap",
				"--repo-key",
				repoKey,
				"--limit-sessions",
				"1",
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					AI_CORTEX_CACHE_HOME: process.env.AI_CORTEX_CACHE_HOME,
				},
			},
		);
		expect(res.status).toBe(0);
		expect(res.stdout).toMatch(/sessionsProcessed:\s*1/);
	});
});
