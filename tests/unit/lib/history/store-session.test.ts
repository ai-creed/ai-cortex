import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSession, readSession, sessionJsonPath } from "../../../../src/lib/history/store.js";
import { HISTORY_SCHEMA_VERSION } from "../../../../src/lib/history/types.js";
import type { SessionRecord } from "../../../../src/lib/history/types.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-history-session-"));
	vi.spyOn(os, "homedir").mockReturnValue(tmp);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
	return {
		version: HISTORY_SCHEMA_VERSION,
		id: "abc",
		startedAt: "2026-04-25T08:00:00.000Z",
		endedAt: null,
		turnCount: 5,
		lastProcessedTurn: 5,
		hasSummary: false,
		hasRaw: true,
		rawDroppedAt: null,
		transcriptPath: "/tmp/abc.jsonl",
		summary: "",
		evidence: { toolCalls: [], filePaths: [], userPrompts: [], corrections: [] },
		chunks: [],
		...overrides,
	};
}

describe("writeSession + readSession", () => {
	it("round-trips a session record", async () => {
		const rec = makeRecord();
		await writeSession("REPO", rec);
		expect(await readSession("REPO", "abc")).toEqual(rec);
	});

	it("creates the session directory if absent", async () => {
		await writeSession("REPO", makeRecord());
		expect(fs.existsSync(path.dirname(sessionJsonPath("REPO", "abc")))).toBe(true);
	});

	it("uses write-temp + rename (no partial files visible)", async () => {
		const rec = makeRecord();
		await writeSession("REPO", rec);
		const dir = path.dirname(sessionJsonPath("REPO", "abc"));
		const stragglers = fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"));
		expect(stragglers).toEqual([]);
	});

	it("readSession returns null when absent", async () => {
		expect(await readSession("REPO", "missing")).toBeNull();
	});
});
