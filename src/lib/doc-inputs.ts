// src/lib/doc-inputs.ts
import fs from "node:fs";
import path from "node:path";
import type { DocInput } from "./models.js";

function scoreDoc(filePath: string): number {
	if (filePath === "README.md") return 100;
	if (filePath.startsWith("docs/shared/architecture")) return 90;
	if (filePath.startsWith("docs/shared/high_level_plan")) return 80;
	if (filePath.startsWith("docs/shared/")) return 70;
	if (filePath.endsWith(".md")) return 10;
	return 0;
}

export function rankDocCandidates(filePaths: string[]): string[] {
	return filePaths
		.filter((p) => p.endsWith(".md"))
		.sort((a, b) => scoreDoc(b) - scoreDoc(a) || a.localeCompare(b));
}

export function loadDocs(
	repoPath: string,
	filePaths: string[],
	limit = 8,
): DocInput[] {
	return rankDocCandidates(filePaths)
		.slice(0, limit)
		.map((filePath) => {
			const body = fs.readFileSync(path.join(repoPath, filePath), "utf8");
			const title =
				body
					.split("\n")
					.find((line) => line.startsWith("# "))
					?.slice(2)
					.trim() ?? filePath;
			return { path: filePath, title, body };
		});
}
