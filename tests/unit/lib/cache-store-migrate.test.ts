import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	runRepoKeyMigrationIfNeeded,
	SENTINEL_NAME,
} from "../../../src/lib/cache-store-migrate.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
});
afterEach(() => {
	delete process.env.AI_CORTEX_CACHE_HOME;
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("runRepoKeyMigrationIfNeeded — sentinel fast-path", () => {
	it("returns already-migrated and writes no work when sentinel exists", async () => {
		const repoKey = "0123456789abcdef";
		const dir = path.join(tmp, repoKey);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, SENTINEL_NAME),
			JSON.stringify({ migratedAt: "2026-05-04T00:00:00Z", outcomes: [] }),
		);

		const result = await runRepoKeyMigrationIfNeeded(repoKey, "/tmp");

		expect(result.outcome).toBe("already-migrated");
		expect(result.details).toEqual([]);
	});
});
