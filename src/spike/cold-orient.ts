import fs from "node:fs";
import path from "node:path";
import { loadDocs } from "./doc-inputs.js";
import { pickPriorityFiles } from "./entry-files.js";
import { listIndexableFiles } from "./indexable-files.js";
import type { RehydrateResult } from "./models.js";
import { extractImportEdgesFromSource } from "./ts-import-graph.js";

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
	const topCandidates = pickPriorityFiles(
		filePaths.filter(filePath => /\.(ts|tsx|js|jsx)$/u.test(filePath)),
		8
	);

	const importedTargets = topCandidates.flatMap(filePath => {
		const source = fs.readFileSync(path.join(repoPath, filePath), "utf8");
		return extractImportEdgesFromSource(filePath, source).map(edge => edge.to);
	});

	const priorityFiles = pickPriorityFiles([...topCandidates, ...importedTargets], 6);
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
