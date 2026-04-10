import fs from "node:fs";
import path from "node:path";
import { loadDocs } from "./doc-inputs.js";
import { listIndexableFiles } from "./indexable-files.js";
import type { RehydrateResult } from "./models.js";
import { extractImportEdgesFromSource } from "./ts-import-graph.js";

function scoreCandidate(filePath: string): number {
	if (filePath === "electron/main/index.ts") return 100;
	if (filePath === "src/main.ts" || filePath === "src/main.tsx") return 95;
	if (filePath === "src/app/App.ts" || filePath === "src/app/App.tsx") return 92;
	if (filePath.startsWith("electron/main/")) return 80;
	if (filePath.startsWith("src/app/")) return 70;
	if (filePath.startsWith("services/")) return 65;
	if (filePath.startsWith("shared/")) return 60;
	if (filePath.startsWith("src/features/")) return 50;
	if (filePath === "package.json") return 40;
	return 0;
}

function unique<T>(items: T[]): T[] {
	return items.filter((value, index, arr) => arr.indexOf(value) === index);
}

function inferProjectTitle(repoPath: string, priorityDocs: ReturnType<typeof loadDocs>): string {
	if (priorityDocs[0]?.title) return priorityDocs[0].title;
	const packageJsonPath = path.join(repoPath, "package.json");
	if (fs.existsSync(packageJsonPath)) {
		try {
			const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { name?: string };
			if (pkg.name) return pkg.name;
		} catch {
			// Ignore invalid package.json in the spike.
		}
	}
	return path.basename(repoPath);
}

export function coldOrient(repoPath: string): RehydrateResult {
	const filePaths = listIndexableFiles(repoPath);
	const docs = loadDocs(repoPath, filePaths, 5);
	const topCandidates = filePaths
		.filter(filePath => /\.(ts|tsx|js|jsx)$/u.test(filePath))
		.map(filePath => ({ path: filePath, score: scoreCandidate(filePath) }))
		.filter(item => item.score > 0)
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
		.slice(0, 8)
		.map(item => item.path);

	const importedTargets = topCandidates.flatMap(filePath => {
		const source = fs.readFileSync(path.join(repoPath, filePath), "utf8");
		return extractImportEdgesFromSource(filePath, source).map(edge => edge.to);
	});

	const priorityFiles = unique([...topCandidates, ...importedTargets]).slice(0, 6);
	const summaryLines = [
		`Project: ${inferProjectTitle(repoPath, docs)}`,
		`Top docs: ${docs.slice(0, 3).map(doc => doc.path).join(", ") || "none"}`,
		`Likely entry files: ${priorityFiles.join(", ") || "none"}`
	];

	return {
		summary: summaryLines.join("\n"),
		priorityDocs: docs.slice(0, 3).map(doc => doc.path),
		priorityFiles,
		stale: false,
		cacheStatus: "missing"
	};
}
