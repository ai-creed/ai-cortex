import { describe, expect, it } from "vitest";
import { rangeFromNode } from "../../../src/lib/adapters/_range.js";

describe("rangeFromNode", () => {
	it("converts tree-sitter 0-indexed/exclusive-end to cortex 1-indexed/inclusive", () => {
		const node = {
			startPosition: { row: 0, column: 0 },
			endPosition: { row: 2, column: 10 },
		};
		expect(rangeFromNode(node)).toEqual({
			line: 1,
			column: 1,
			endLine: 3,
			endColumn: 10,
		});
	});

	it("handles a single-line node", () => {
		const node = {
			startPosition: { row: 4, column: 7 },
			endPosition: { row: 4, column: 12 },
		};
		expect(rangeFromNode(node)).toEqual({
			line: 5,
			column: 8,
			endLine: 5,
			endColumn: 12,
		});
	});
});
