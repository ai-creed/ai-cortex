// src/lib/diff-files.ts
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function hashFileContent(
	worktreePath: string,
	filePath: string,
): string {
	const content = fs.readFileSync(path.join(worktreePath, filePath));
	return createHash("sha256").update(content).digest("hex");
}
