import { it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSink, writeEvent } from "../../../../src/lib/stats/sink.js";
import { runStatsSessions } from "../../../../src/lib/stats/cli/sessions.js";

const KEY = "0123456789abcdef";
let home: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "aicx-clises-"));
	process.env.AI_CORTEX_CACHE_HOME = home;
});
afterEach(() => {
	delete process.env.AI_CORTEX_CACHE_HOME;
	fs.rmSync(home, { recursive: true, force: true });
});

it("--json emits {sessions,summary}", () => {
	const s = openSink(KEY);
	writeEvent(s, {
		ts: Date.now(),
		tool: "get_memory",
		dur_ms: 1,
		status: "ok",
		session_id: "Z",
	});
	s.close();
	let out = "";
	const code = runStatsSessions(
		{ repoKey: KEY, window: "7d", json: true },
		(t) => {
			out += t;
		},
	);
	expect(code).toBe(0);
	const parsed = JSON.parse(out);
	expect(parsed.summary.memoryUsedPct).toBe(100);
	expect(parsed.sessions[0].sessionId).toBe("Z");
});

it("text mode prints the headline", () => {
	const s = openSink(KEY);
	writeEvent(s, {
		ts: Date.now(),
		tool: "record_memory",
		dur_ms: 1,
		status: "ok",
		session_id: "Z",
	});
	s.close();
	let out = "";
	runStatsSessions({ repoKey: KEY, window: "7d", json: false }, (t) => {
		out += t;
	});
	expect(out).toMatch(/memory used/i);
});
