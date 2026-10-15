// src/lib/adapters/_range.ts
import type { Range } from "../models.js";

type NodeLike = {
	startPosition: { row: number; column: number };
	endPosition: { row: number; column: number };
	text?: string;
};

/**
 * Convert a tree-sitter node's position to a cortex Range.
 * Tree-sitter: row/column 0-indexed; startPosition inclusive; endPosition.column
 * is exclusive (one past the last character). Cortex: 1-indexed, inclusive both ends.
 * endColumn maps directly: exclusive 0-indexed end == inclusive 1-indexed end.
 * A node that swallows its trailing newline (a `#define` line) ends at column 0
 * of the next row; its inclusive end is the last character before the newline.
 */
export function rangeFromNode(node: NodeLike): Range {
	if (
		node.endPosition.column === 0 &&
		node.endPosition.row > node.startPosition.row &&
		node.text !== undefined
	) {
		const lines = node.text.replace(/(\r?\n)+$/u, "").split("\n");
		const last = lines[lines.length - 1].replace(/\r$/u, "");
		return {
			line: node.startPosition.row + 1,
			column: node.startPosition.column + 1,
			endLine: node.startPosition.row + lines.length,
			endColumn:
				lines.length === 1
					? node.startPosition.column + last.length
					: last.length,
		};
	}
	return {
		line: node.startPosition.row + 1,
		column: node.startPosition.column + 1,
		endLine: node.endPosition.row + 1,
		endColumn: node.endPosition.column,
	};
}
