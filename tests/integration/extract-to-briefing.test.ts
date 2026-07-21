// tests/integration/extract-to-briefing.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureSession } from "../../src/lib/history/capture.js";
import { renderMemoryDigest } from "../../src/lib/memory/briefing-digest.js";
import { reviewPendingCaptures } from "../../src/lib/memory/pending-captures.js";
import { openMemoryIndex } from "../../src/lib/memory/index.js";

const FIXTURE = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
	"history",
	"sample.jsonl",
);
const REPO_KEY = "aabbccdd00112233";

let tmp: string;
let savedCacheHome: string | undefined;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-extract-brief-"));
	vi.spyOn(os, "homedir").mockReturnValue(tmp);
	savedCacheHome = process.env.AI_CORTEX_CACHE_HOME;
	process.env.AI_CORTEX_CACHE_HOME = tmp;
	process.env.AI_CORTEX_SESSION_ID = "int-sess";
});

afterEach(() => {
	if (savedCacheHome !== undefined)
		process.env.AI_CORTEX_CACHE_HOME = savedCacheHome;
	else delete process.env.AI_CORTEX_CACHE_HOME;
	fs.rmSync(tmp, { recursive: true, force: true });
	delete process.env.AI_CORTEX_SESSION_ID;
});

describe("extraction → briefing end-to-end", () => {
	it("zero-signal extracted captures are discarded at intake — never a candidate, never in the briefing", async () => {
		const result = await captureSession({
			repoKey: REPO_KEY,
			sessionId: "int-sess",
			transcriptPath: FIXTURE,
			embed: false,
		});
		expect(result.status).toBe("captured");

		// Task 3 (intake tier routing): the fixture's only structurally
		// surviving turn ("please look at src/foo.ts") is zero-signal (no
		// standing-directive/rationale/correction marker) — the correction
		// turn ("no, use the watch mode instead") is independently rejected
		// by the structural gate's vague-ack rule. Under the default
		// intakeTierRouting, the zero-signal survivor is routed straight to
		// trash at extraction: it never becomes a `candidate` row, so it can
		// no longer surface via reviewPendingCaptures even with
		// includeLowSignal — it already left candidate state entirely.
		const idx = openMemoryIndex(REPO_KEY);
		let rows: { status: string }[];
		try {
			rows = idx.rawDb().prepare("SELECT status FROM memories").all() as {
				status: string;
			}[];
		} finally {
			idx.close();
		}
		expect(rows).toHaveLength(1);
		expect(rows[0]!.status).toBe("trashed");

		const high = await reviewPendingCaptures(REPO_KEY, { limit: 50 });
		const all = await reviewPendingCaptures(REPO_KEY, {
			limit: 50,
			includeLowSignal: true,
		});
		expect(high.length).toBe(0);
		expect(all.length).toBe(0);

		// With the sole extracted row trashed (neither active nor candidate),
		// there is nothing left to brief: renderMemoryDigest returns null
		// rather than a digest with an empty/zero-count captures section —
		// so the discarded capture provably never leaks into "Captures
		// pending confirmation" nor the generic "Pending review" queue.
		const md = await renderMemoryDigest(REPO_KEY);
		expect(md).toBeNull();
	});
});
