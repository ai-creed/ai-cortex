import path from "node:path";
import type { ImportEdge } from "./models.js";

const IMPORT_RE = /from\s+['"]([^'"]+)['"]/g;

export function extractImportEdgesFromSource(filePath: string, source: string): ImportEdge[] {
	const edges: ImportEdge[] = [];
	for (const match of source.matchAll(IMPORT_RE)) {
		const specifier = match[1];
		if (!specifier.startsWith(".")) continue;
		const resolved = path
			.normalize(path.join(path.dirname(filePath), specifier))
			.replace(/\\/g, "/")
			.replace(/\.(ts|tsx|js|jsx)$/u, "");
		edges.push({ from: filePath, to: resolved });
	}
	return edges;
}
