import { execFileSync } from "node:child_process";
import type { FileNode } from "./models.js";
import { collectFileTree } from "./file-tree.js";

function parseGitLsFiles(output: string): string[] {
	return output
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.sort();
}

function fallbackIndexableFiles(repoPath: string): string[] {
	return collectFileTree(repoPath)
		.filter(node => node.kind === "file")
		.map(node => node.path)
		.sort();
}

export function listIndexableFiles(repoPath: string): string[] {
	try {
		const output = execFileSync(
			"git",
			["-C", repoPath, "ls-files", "--cached", "--others", "--exclude-standard"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
		);
		return parseGitLsFiles(output);
	} catch {
		return fallbackIndexableFiles(repoPath);
	}
}

export function buildIndexableTree(repoPath: string): FileNode[] {
	const filePaths = listIndexableFiles(repoPath);
	const dirPaths = new Set<string>();

	for (const filePath of filePaths) {
		const segments = filePath.split("/");
		for (let index = 1; index < segments.length; index++) {
			dirPaths.add(segments.slice(0, index).join("/"));
		}
	}

	return [
		...[...dirPaths].sort().map(path => ({ path, kind: "dir" as const })),
		...filePaths.map(path => ({ path, kind: "file" as const }))
	];
}
