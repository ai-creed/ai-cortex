// tests/integration/extract-to-briefing.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureSession } from "../../src/lib/history/capture.js";
import { renderMemoryDigest } from "../../src/lib/memory/briefing-digest.js";
import { reviewPendingCaptures } from "../../src/lib/memory/pending-captures.js";

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
	it("extracted captures land tier-aware in the briefing and never in generic Pending review", async () => {
		const result = await captureSession({
			repoKey: REPO_KEY,
			sessionId: "int-sess",
			transcriptPath: FIXTURE,
			embed: false,
		});
		expect(result.status).toBe("captured");

		// Extraction must have produced capture candidates (the fixture's
		// user correction survives the gate as a correction-shape turn).
		const high = await reviewPendingCaptures(REPO_KEY, { limit: 50 });
		const all = await reviewPendingCaptures(REPO_KEY, {
			limit: 50,
			includeLowSignal: true,
		});
		expect(all.length).toBeGreaterThan(0);
		const lowCount = all.length - high.length;

		const md = await renderMemoryDigest(REPO_KEY);
		expect(md).not.toBeNull();
		// Tier-aware captures count: header high count equals the default
		// (high-tier) review queue; low tier disclosed iff present.
		const suffix =
			lowCount > 0 ? ` \\(\\+${lowCount} low-signal, auto-expiring\\)` : "";
		expect(md!).toMatch(
			new RegExp(`## Captures pending confirmation — ${high.length}${suffix}`),
		);
		// Disjointness at the pipeline layer: extraction creates ONLY
		// type='capture' candidates, so the generic queue stays empty.
		expect(md!).not.toContain("## Pending review");
	});
});
