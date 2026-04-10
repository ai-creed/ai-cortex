// src/lib/import-graph.ts
import fs from "node:fs";
import path from "node:path";
import type { ImportEdge } from "./models.js";

const IMPORT_RE = /from\s+['"]([^'"]+)['"]/g;
const TS_EXTS = /\.(ts|tsx|js|jsx)$/u;

export function extractImportEdgesFromSource(
	filePath: string,
	source: string,
): ImportEdge[] {
	const edges: ImportEdge[] = [];
	for (const match of source.matchAll(IMPORT_RE)) {
		const specifier = match[1];
		if (!specifier.startsWith(".")) continue;
		const resolved = path
			.normalize(path.join(path.dirname(filePath), specifier))
			.replace(/\\/g, "/")
			.replace(TS_EXTS, "");
		edges.push({ from: filePath, to: resolved });
	}
	return edges;
}

export function extractImports(
	worktreePath: string,
	filePaths: string[],
): ImportEdge[] {
	return filePaths
		.filter((filePath) => TS_EXTS.test(filePath))
		.flatMap((filePath) => {
			const source = fs.readFileSync(path.join(worktreePath, filePath), "utf8");
			return extractImportEdgesFromSource(filePath, source);
		});
}
