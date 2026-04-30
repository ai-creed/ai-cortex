import { describe, expect, it } from "vitest";
import {
	liftHarnessSummary,
	chunkTurns,
} from "../../../../src/lib/history/compact.js";
import type { RawTurn } from "../../../../src/lib/history/types.js";

describe("liftHarnessSummary", () => {
	it("returns concatenated summary text from compact-summary turns", () => {
		const turns: RawTurn[] = [
			{ turn: 0, role: "user", text: "hi" },
			{
				turn: 1,
				role: "system",
				text: "First summary block.",
				isCompactSummary: true,
			},
			{ turn: 2, role: "user", text: "more" },
			{
				turn: 3,
				role: "system",
				text: "Second summary block.",
				isCompactSummary: true,
			},
		];
		expect(liftHarnessSummary(turns)).toBe(
			"First summary block.\n\nSecond summary block.",
		);
	});

	it("returns empty string when no summary turns", () => {
		expect(liftHarnessSummary([{ turn: 0, role: "user", text: "x" }])).toBe("");
	});
});

describe("chunkTurns", () => {
	it("splits transcript into chunks of approx target size", () => {
		const big = "word ".repeat(600).trim();
		const turns: RawTurn[] = [{ turn: 0, role: "user", text: big }];
		const chunks = chunkTurns(turns, { targetTokens: 100 });
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) {
			expect(c.text.length).toBeGreaterThan(0);
			expect(c.tokenStart).toBeLessThan(c.tokenEnd);
		}
	});

	it("each chunk preview is at most 80 chars", () => {
		const turns: RawTurn[] = [{ turn: 0, role: "user", text: "short turn" }];
		const chunks = chunkTurns(turns, { targetTokens: 100 });
		expect(chunks[0].preview.length).toBeLessThanOrEqual(80);
	});

	it("ids are sequential from 0", () => {
		const turns: RawTurn[] = Array.from({ length: 5 }, (_, i) => ({
			turn: i,
			role: "user" as const,
			text: `turn ${i}`,
		}));
		const chunks = chunkTurns(turns, { targetTokens: 5 });
		expect(chunks.map((c) => c.id)).toEqual(chunks.map((_, i) => i));
	});
});
