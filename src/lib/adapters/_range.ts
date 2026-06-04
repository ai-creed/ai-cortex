// src/lib/adapters/_range.ts
import type { Range } from "../models.js";

type NodeLike = {
	startPosition: { row: number; column: number };
	endPosition: { row: number; column: number };
};

/**
 * Convert a tree-sitter node's position to a cortex Range.
 * Tree-sitter: row/column 0-indexed; startPosition inclusive; endPosition.column
 * is exclusive (one past the last character). Cortex: 1-indexed, inclusive both ends.
 * endColumn maps directly: exclusive 0-indexed end == inclusive 1-indexed end.
 */
export function rangeFromNode(node: NodeLike): Range {
	return {
		line: node.startPosition.row + 1,
		column: node.startPosition.column + 1,
		endLine: node.endPosition.row + 1,
		endColumn: node.endPosition.column,
	};
}
