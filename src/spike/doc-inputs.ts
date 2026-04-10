import fs from "node:fs";
import path from "node:path";
import type { DocInput } from "./models.js";

export function rankDocCandidates(paths: string[]): string[] {
	const score = (filePath: string): number => {
		if (filePath === "README.md") return 100;
		if (filePath.startsWith("docs/shared/architecture")) return 90;
		if (filePath.startsWith("docs/shared/high_level_plan")) return 80;
		if (filePath.startsWith("docs/shared/")) return 70;
		if (filePath.endsWith(".md")) return 10;
		return 0;
	};

	return [...paths]
		.filter(filePath => filePath.endsWith(".md"))
		.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}

export function loadDocs(repoPath: string, paths: string[], limit = 8): DocInput[] {
	const ranked = rankDocCandidates(paths).slice(0, limit);
	return ranked.map(filePath => {
		const body = fs.readFileSync(path.join(repoPath, filePath), "utf8");
		const title = body.split("\n").find(line => line.startsWith("# "))?.slice(2) || filePath;
		return { path: filePath, title, body };
	});
}
