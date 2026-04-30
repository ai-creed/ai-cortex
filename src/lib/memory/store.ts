import fs from "node:fs/promises";
import path from "node:path";
import { memoriesDir, trashDir, memoryFilePath } from "./paths.js";
import { parseMemoryMarkdown, serializeMemoryMarkdown } from "./markdown.js";
import type { MemoryRecord } from "./types.js";

export type MemoryFileEntry = {
	id: string;
	location: "memories" | "trash";
	mtimeMs: number;
};

async function ensureDirs(repoKey: string): Promise<void> {
	await fs.mkdir(memoriesDir(repoKey), { recursive: true });
	await fs.mkdir(trashDir(repoKey), { recursive: true });
}

export async function writeMemoryFile(
	repoKey: string,
	record: MemoryRecord,
): Promise<void> {
	await ensureDirs(repoKey);
	const finalPath = memoryFilePath(repoKey, record.frontmatter.id, "memories");
	const tmpPath = `${finalPath}.tmp`;
	const text = serializeMemoryMarkdown(record);

	const fh = await fs.open(tmpPath, "w");
	try {
		await fh.writeFile(text);
		await fh.sync();
	} finally {
		await fh.close();
	}
	await fs.rename(tmpPath, finalPath);
}

export async function readMemoryFile(
	repoKey: string,
	id: string,
	location: "memories" | "trash",
): Promise<MemoryRecord> {
	const text = await fs.readFile(memoryFilePath(repoKey, id, location), "utf8");
	return parseMemoryMarkdown(text);
}

export async function listMemoryFiles(
	repoKey: string,
): Promise<MemoryFileEntry[]> {
	await ensureDirs(repoKey);
	const out: MemoryFileEntry[] = [];
	for (const location of ["memories", "trash"] as const) {
		const dir =
			location === "memories" ? memoriesDir(repoKey) : trashDir(repoKey);
		const names = await fs.readdir(dir);
		for (const name of names) {
			if (!name.endsWith(".md")) continue;
			const stat = await fs.stat(path.join(dir, name));
			out.push({ id: name.slice(0, -3), location, mtimeMs: stat.mtimeMs });
		}
	}
	return out;
}

export async function moveToTrash(repoKey: string, id: string): Promise<void> {
	const from = memoryFilePath(repoKey, id, "memories");
	const to = memoryFilePath(repoKey, id, "trash");
	await fs.mkdir(trashDir(repoKey), { recursive: true });
	await fs.rename(from, to);
}

export async function restoreFromTrash(
	repoKey: string,
	id: string,
): Promise<void> {
	const from = memoryFilePath(repoKey, id, "trash");
	const to = memoryFilePath(repoKey, id, "memories");
	await fs.mkdir(memoriesDir(repoKey), { recursive: true });
	await fs.rename(from, to);
}

export async function purgeMemoryFile(
	repoKey: string,
	id: string,
	location: "memories" | "trash",
): Promise<void> {
	try {
		await fs.unlink(memoryFilePath(repoKey, id, location));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
}
