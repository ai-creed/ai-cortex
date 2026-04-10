import fs from "node:fs";
import path from "node:path";
import { collectFileTree } from "./file-tree.js";

export function coldScanBaseline(repoPath: string): {
	filesTouched: number;
	markdownFilesRead: number;
} {
	const files = collectFileTree(repoPath).filter(node => node.kind === "file");
	let markdownFilesRead = 0;

	for (const file of files) {
		if (!file.path.endsWith(".md")) continue;
		fs.readFileSync(path.join(repoPath, file.path), "utf8");
		markdownFilesRead++;
	}

	return {
		filesTouched: files.length,
		markdownFilesRead
	};
}
