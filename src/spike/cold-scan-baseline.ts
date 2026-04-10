import fs from "node:fs";
import path from "node:path";
import { listIndexableFiles } from "./indexable-files.js";

export function coldScanBaseline(repoPath: string): {
	filesTouched: number;
	markdownFilesRead: number;
} {
	const files = listIndexableFiles(repoPath);
	let markdownFilesRead = 0;

	for (const file of files) {
		if (!file.endsWith(".md")) continue;
		fs.readFileSync(path.join(repoPath, file), "utf8");
		markdownFilesRead++;
	}

	return {
		filesTouched: files.length,
		markdownFilesRead
	};
}
