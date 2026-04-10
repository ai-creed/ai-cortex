import fs from "node:fs";
import path from "node:path";
import type { FileNode } from "./models.js";

const IGNORE_DIRS = new Set([".git", "node_modules", "dist", "out", "build"]);

export function collectFileTree(repoPath: string): FileNode[] {
	const out: FileNode[] = [];

	function walk(current: string): void {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;
			const abs = path.join(current, entry.name);
			const rel = path.relative(repoPath, abs);
			out.push({ path: rel, kind: entry.isDirectory() ? "dir" : "file" });
			if (entry.isDirectory()) walk(abs);
		}
	}

	walk(repoPath);
	return out;
}
