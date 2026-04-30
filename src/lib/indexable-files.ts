// src/lib/indexable-files.ts
import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const IGNORE_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"out",
	"build",
	"release",
]);

async function walkFs(dir: string, root: string): Promise<string[]> {
	const results: string[] = [];
	const entries = await fs.promises.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...(await walkFs(abs, root)));
		} else {
			results.push(path.relative(root, abs));
		}
	}
	return results;
}

export async function listIndexableFiles(repoPath: string): Promise<string[]> {
	try {
		const { stdout } = await execAsync(
			`git -C ${JSON.stringify(repoPath)} ls-files --cached --others --exclude-standard`,
		);
		const candidates = stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		const results: string[] = [];
		for (const f of candidates) {
			const abs = path.join(repoPath, f);
			try {
				const stat = await fs.promises.stat(abs);
				if (!stat.isDirectory()) results.push(f);
			} catch {
				// skip inaccessible
			}
		}
		return results.sort();
	} catch {
		return (await walkFs(repoPath, repoPath)).sort();
	}
}
