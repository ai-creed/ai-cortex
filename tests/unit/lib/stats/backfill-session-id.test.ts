import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { backfillRepo } from "../../../../src/lib/stats/backfill.js";
import { statsDbPath } from "../../../../src/lib/stats/paths.js";
import { sessionJsonPath } from "../../../../src/lib/history/store.js";

const KEY = "0123456789abcdef";
let home: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "aicx-bf-"));
	process.env.AI_CORTEX_CACHE_HOME = home;
});
afterEach(() => {
	delete process.env.AI_CORTEX_CACHE_HOME;
	fs.rmSync(home, { recursive: true, force: true });
});

describe("backfill session-id attribution", () => {
	it("synthetic rows carry session_id = session dir name", () => {
		const sid = "sess-001";
		const sp = sessionJsonPath(KEY, sid);
		fs.mkdirSync(path.dirname(sp), { recursive: true });
		fs.writeFileSync(
			sp,
			JSON.stringify({
				startedAt: new Date().toISOString(),
				evidence: {
					toolCalls: [{ name: "recall_memory" }, { name: "get_memory" }],
				},
			}),
		);
		backfillRepo(KEY);
		const db = new Database(statsDbPath(KEY), { readonly: true });
		const rows = db
			.prepare("SELECT session_id FROM tool_calls WHERE synthetic=1")
			.all() as Array<{ session_id: string | null }>;
		db.close();
		expect(rows.length).toBe(2);
		expect(rows.every((r) => r.session_id === sid)).toBe(true);
	});
});
