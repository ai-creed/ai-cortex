// src/lib/indexable-files.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const IGNORE_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"out",
	"build",
	"release",
]);

function walkFs(dir: string, root: string): string[] {
	const results: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...walkFs(abs, root));
		} else {
			results.push(path.relative(root, abs));
		}
	}
	return results;
}

export function listIndexableFiles(repoPath: string): string[] {
	try {
		const output = execFileSync(
			"git",
			[
				"-C",
				repoPath,
				"ls-files",
				"--cached",
				"--others",
				"--exclude-standard",
			],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		);
		return output
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.filter((f) => {
				const abs = path.join(repoPath, f);
				return fs.existsSync(abs) && !fs.statSync(abs).isDirectory();
			})
			.sort();
	} catch {
		return walkFs(repoPath, repoPath).sort();
	}
}
