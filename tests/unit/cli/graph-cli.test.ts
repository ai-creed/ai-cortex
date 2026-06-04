import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { mkRepoKey, cleanupRepo } from "../../helpers/memory-fixtures.js";
import { transcodeCacheToDb } from "../../../src/lib/cache-store-sqlite.js";
import { getCacheDbFilePath } from "../../../src/lib/cache-store.js";
import { runGraphCommand } from "../../../src/cli/graph.js";
import type { RepoCache } from "../../../src/lib/models.js";

function cache(repoKey: string): RepoCache {
	return {
		schemaVersion: "3.1",
		repoKey,
		worktreeKey: "wt00000000000000",
		worktreePath: "/wt",
		indexedAt: "t",
		fingerprint: "f",
		packageMeta: { name: "fix", version: "0.0.0", framework: null },
		entryFiles: [],
		files: [{ path: "a.ts", kind: "file" }],
		docs: [],
		imports: [],
		functions: [],
		calls: [],
	};
}

describe("cortex graph --export", () => {
	const keys: string[] = [];
	afterEach(async () => {
		for (const k of keys.splice(0)) await cleanupRepo(k);
	});

	it("writes a GraphPayload JSON file and starts no server", async () => {
		const repoKey = await mkRepoKey("graph-cli");
		keys.push(repoKey);
		transcodeCacheToDb(
			cache(repoKey),
			getCacheDbFilePath(repoKey, "wt00000000000000"),
		);

		const out = path.join(os.tmpdir(), `graph-${repoKey}.json`);
		let serverStarted = false;
		const code = await runGraphCommand(["--mode", "code", "--export", out], {
			startServer: async () => {
				serverStarted = true;
				return { url: "", port: 0, stop: async () => {} };
			},
			openBrowser: async () => {},
		});
		expect(code).toBe(0);
		expect(serverStarted).toBe(false);
		const payload = JSON.parse(fs.readFileSync(out, "utf8"));
		expect(payload.mode).toBe("code");
		expect(
			payload.nodes.some((n: { id: string }) => n.id === `project:${repoKey}`),
		).toBe(true);
		fs.rmSync(out, { force: true });
	});
});
