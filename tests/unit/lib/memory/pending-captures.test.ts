import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	openLifecycle,
	createMemory,
	confirmMemory,
	addEvidence,
} from "../../../../src/lib/memory/lifecycle.js";
import { writeSession } from "../../../../src/lib/history/store.js";
import { mkRepoKey, cleanupRepo } from "../../../helpers/memory-fixtures.js";
import { reviewPendingCaptures } from "../../../../src/lib/memory/pending-captures.js";
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
		startedAt: "2026-04-30T00:00:00Z",
		endedAt: "2026-04-30T01:00:00Z",
		turnCount: maxTurn,
		lastProcessedTurn: maxTurn,
		hasSummary: false,
		hasRaw: true,
		rawDroppedAt: null,
		transcriptPath: "/tmp/does-not-exist-pending-captures",
		summary: "",
		evidence: {
			toolCalls: [],
			filePaths: [],
			userPrompts,
			corrections: [],
		},
		chunks: [],
		...overrides,
	};
}

describe("reviewPendingCaptures", () => {
	let repoKey: string;
	beforeEach(async () => {
		repoKey = await mkRepoKey("pending-captures");
	});
	afterEach(async () => {
		await cleanupRepo(repoKey);
	});

	it("returns only source=extracted status=candidate; ordered by signalScore desc; body-only when no session", async () => {
		const lc = await openLifecycle(repoKey);
		try {
			const weak = await createMemory(lc, {
				type: "capture",
				title: "we changed the color",
				body: "we changed the button color",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			const strong = await createMemory(lc, {
				type: "capture",
				title: "always run tests",
				body: "always run tests before commit because CI is slow",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			await createMemory(lc, {
				type: "decision",
				title: "explicit one",
				body: "x",
				scope: { files: [], tags: [] },
				source: "explicit",
			});
			await confirmMemory(lc, weak); // → active, must drop out
			const out = await reviewPendingCaptures(repoKey, { limit: 10 });
			expect(out.map((o) => o.id)).toEqual([strong]); // weak active, explicit not extracted
			expect(out[0].context.kind).toBe("body-only");
			expect(out[0].signalScore).toBeGreaterThanOrEqual(1);
			// internal sort key must not leak
			expect(
				(out[0] as unknown as { _updatedAt?: string })._updatedAt,
			).toBeUndefined();
		} finally {
			lc.close();
		}
	});

	it("resolves the evidence-pair tier when the session has a matching userPrompt turn", async () => {
		await writeSession(
			repoKey,
			sess("s-ev", [
				{
					turn: 7,
					text: "always run the linter before pushing",
					nextAssistantSnippet: "Understood — I will run the linter first.",
				},
			]),
		);
		const lc = await openLifecycle(repoKey);
		try {
			const id = await createMemory(lc, {
				type: "capture",
				title: "lint before push",
				body: "always run the linter before pushing because CI is slow",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			await addEvidence(lc, id, {
				sessionId: "s-ev",
				turn: 7,
				kind: "user_prompt",
			});
			const out = await reviewPendingCaptures(repoKey, { limit: 10 });
			expect(out).toHaveLength(1);
			expect(out[0].context.kind).toBe("evidence");
			if (out[0].context.kind === "evidence") {
				expect(out[0].context.userTurn).toBe(
					"always run the linter before pushing",
				);
				expect(out[0].context.assistantSnippet).toBe(
					"Understood — I will run the linter first.",
				);
			}
			expect(out[0].source).toEqual({ sessionId: "s-ev", turn: 7 });
		} finally {
			lc.close();
		}
	});

	it("falls back to body-only when the provenance turn has no matching userPrompt", async () => {
		await writeSession(
			repoKey,
			sess("s-nomatch", [{ turn: 1, text: "unrelated prompt" }]),
		);
		const lc = await openLifecycle(repoKey);
		try {
			const id = await createMemory(lc, {
				type: "capture",
				title: "orphan turn",
				body: "always document public APIs because consumers depend on them",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			await addEvidence(lc, id, {
				sessionId: "s-nomatch",
				turn: 99,
				kind: "user_prompt",
			});
			const out = await reviewPendingCaptures(repoKey, { limit: 10 });
			expect(out).toHaveLength(1);
			expect(out[0].context.kind).toBe("body-only");
		} finally {
			lc.close();
		}
	});

	it("resolves the transcript-window tier from a real JSONL transcript", async () => {
		const tdir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-trans-"));
		const tpath = path.join(tdir, "transcript.jsonl");
		const lines = [
			{
				type: "user",
				turn: 4,
				message: { content: "always run the linter before pushing" },
			},
			{
				type: "assistant",
				turn: 5,
				message: {
					content: [{ type: "text", text: "Got it, linting before push." }],
				},
			},
			{
				type: "user",
				turn: 12,
				message: { content: "unrelated far-away prompt" },
			},
		];
		fs.writeFileSync(
			tpath,
			lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
		);
		try {
			await writeSession(
				repoKey,
				sess("s-tr", [{ turn: 5, text: "always run the linter before pushing" }], {
					transcriptPath: tpath,
				}),
			);
			const lc = await openLifecycle(repoKey);
			try {
				const id = await createMemory(lc, {
					type: "capture",
					title: "lint before push",
					body: "always run the linter before pushing because CI is slow",
					scope: { files: [], tags: [] },
					source: "extracted",
				});
				await addEvidence(lc, id, {
					sessionId: "s-tr",
					turn: 5,
					kind: "user_prompt",
				});
				const out = await reviewPendingCaptures(repoKey, { limit: 10 });
				expect(out).toHaveLength(1);
				expect(out[0].context.kind).toBe("transcript");
				if (out[0].context.kind === "transcript") {
					const texts = out[0].context.turns.map((t) => t.text);
					expect(texts.join(" ")).toContain(
						"always run the linter before pushing",
					);
					expect(texts.join(" ")).toContain("Got it, linting before push.");
					expect(texts.join(" ")).not.toContain("unrelated far-away prompt");
				}
			} finally {
				lc.close();
			}
		} finally {
			fs.rmSync(tdir, { recursive: true, force: true });
		}
	});

	it("honors limit by slicing the signalScore-sorted full set", async () => {
		const lc = await openLifecycle(repoKey);
		try {
			await createMemory(lc, {
				type: "capture",
				title: "low",
				body: "we changed the button color",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			const high = await createMemory(lc, {
				type: "capture",
				title: "high",
				body: "always run tests before commit because CI is slow; no, don't skip",
				scope: { files: [], tags: [] },
				source: "extracted",
			});
			const out = await reviewPendingCaptures(repoKey, { limit: 1 });
			expect(out.map((o) => o.id)).toEqual([high]);
		} finally {
			lc.close();
		}
	});
});
