// tests/integration/history-pipeline.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureSession } from "../../src/lib/history/capture.js";
import { searchHistory } from "../../src/lib/history/search.js";

const FIXTURE = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
	"history",
	"sample.jsonl",
);

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-history-int-"));
	vi.spyOn(os, "homedir").mockReturnValue(tmp);
	process.env.AI_CORTEX_SESSION_ID = "int-sess";
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
	delete process.env.AI_CORTEX_SESSION_ID;
});

describe("history pipeline end-to-end", () => {
	it("captures fixture, then search finds the user correction by lexical query", async () => {
		await captureSession({ repoKey: "REPO", sessionId: "int-sess", transcriptPath: FIXTURE, embed: false });
		const result = await searchHistory({
			repoKey: "REPO",
			cwd: "/tmp/anything",
			query: "watch mode",
			scope: "session",
			sessionId: "int-sess",
		});
		expect(result.hits.some((h) => h.kind === "correction")).toBe(true);
	});

	it("running capture twice on same transcript is a no-op", async () => {
		const first = await captureSession({ repoKey: "REPO", sessionId: "int-sess", transcriptPath: FIXTURE, embed: false });
		const second = await captureSession({ repoKey: "REPO", sessionId: "int-sess", transcriptPath: FIXTURE, embed: false });
		expect(first.status).toBe("captured");
		expect(second.status).toBe("up-to-date");
	});
});
