import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { extractFromSession } from "../../../../src/lib/memory/extract.js";
import * as lifecycle from "../../../../src/lib/memory/lifecycle.js";
import { writeSession } from "../../../../src/lib/history/store.js";
import { openMemoryIndex } from "../../../../src/lib/memory/index.js";
import { readMemoryVector } from "../../../../src/lib/memory/embed.js";
import { memoryRootDir } from "../../../../src/lib/memory/paths.js";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";
import type {
	SessionRecord,
	UserPromptEvidence,
} from "../../../../src/lib/history/types.js";

function sess(
	id: string,
	userPrompts: UserPromptEvidence[],
	overrides: Partial<SessionRecord> = {},
): SessionRecord {
	const maxTurn = userPrompts.reduce((m, u) => Math.max(m, u.turn), 0);
	return {
		version: 2,
		id,
		startedAt: "2026-07-20T00:00:00Z",
		endedAt: "2026-07-20T01:00:00Z",
		turnCount: maxTurn,
		lastProcessedTurn: maxTurn,
		hasSummary: false,
		hasRaw: true,
		rawDroppedAt: null,
		transcriptPath: "/tmp/x",
		summary: "",
		evidence: { toolCalls: [], filePaths: [], userPrompts, corrections: [] },
		chunks: [],
		...overrides,
	};
}

// Zero signal: imperative, no standing-directive/rationale/correction marker.
const LOW = "commit the changes and push them to the remote branch please";
// High signal: standing directive ("always") + rationale ("because").
const HIGH =
	"Always run the full gate before tagging because skipped gates burned v0.10.1";

describe("tier routing at extraction", () => {
	let repoKey: string;
	afterEach(async () => {
		vi.restoreAllMocks();
		if (repoKey) await cleanupRepo(repoKey);
	});

	async function statuses(rk: string): Promise<{ status: string; id: string }[]> {
		const idx = openMemoryIndex(rk);
		try {
			return idx
				.rawDb()
				.prepare("SELECT id, status FROM memories")
				.all() as { status: string; id: string }[];
		} finally {
			idx.close();
		}
	}

	it("routes zero-signal to trash with reason, no vector; manifest records it", async () => {
		repoKey = await mkRepoKey("intake-v2");
		await writeSession(repoKey, sess("s1", [
			{ turn: 1, text: LOW, nextAssistantSnippet: "Done." },
		]));
		const manifest = await extractFromSession(repoKey, "s1");
		expect(manifest.candidatesCreated).toBe(0);
		expect(manifest.discardedCount).toBe(1);
		expect(manifest.discardedCaptures).toEqual([
			{ title: expect.any(String), reason: "intake: zero-signal capture" },
		]);
		const rows = await statuses(repoKey);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.status).toBe("trashed");
		expect(await readMemoryVector(repoKey, rows[0]!.id)).toBeNull();
	});

	it("keeps high-signal captures as candidates", async () => {
		repoKey = await mkRepoKey("intake-v2");
		await writeSession(repoKey, sess("s2", [
			{ turn: 1, text: HIGH, nextAssistantSnippet: "Noted." },
		]));
		const manifest = await extractFromSession(repoKey, "s2");
		expect(manifest.candidatesCreated).toBe(1);
		expect(manifest.discardedCount ?? 0).toBe(0);
		const rows = await statuses(repoKey);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.status).toBe("candidate");
	});

	it("flag off restores current behavior (low-signal becomes candidate)", async () => {
		repoKey = await mkRepoKey("intake-v2");
		const root = memoryRootDir(repoKey);
		await fs.mkdir(root, { recursive: true });
		await fs.writeFile(
			path.join(root, "config.json"),
			JSON.stringify({ memory: { intakeTierRouting: false } }),
		);
		await writeSession(repoKey, sess("s3", [
			{ turn: 1, text: LOW, nextAssistantSnippet: "Done." },
		]));
		const manifest = await extractFromSession(repoKey, "s3");
		expect(manifest.candidatesCreated).toBe(1);
		const rows = await statuses(repoKey);
		expect(rows[0]!.status).toBe("candidate");
	});

	it("discard failure falls back to candidate creation and logs stderr", async () => {
		repoKey = await mkRepoKey("intake-v2");
		await writeSession(repoKey, sess("s4", [
			{ turn: 1, text: LOW, nextAssistantSnippet: "Done." },
		]));
		vi.spyOn(lifecycle, "createDiscardedCapture").mockRejectedValue(
			new Error("injected discard failure"),
		);
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manifest = await extractFromSession(repoKey, "s4");
		expect(manifest.candidatesCreated).toBe(1);
		expect(manifest.discardedCount ?? 0).toBe(0);
		const rows = await statuses(repoKey);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.status).toBe("candidate");
		expect(errSpy).toHaveBeenCalled();
	});
});
