// src/lib/library/doc-walker.ts
import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";

export const PRUNE_DIRS = new Set([
	"node_modules",
	"dist",
	"build",
	"out",
	".next",
	".svelte-kit",
	".turbo",
	"coverage",
	"vendor",
	".venv",
	"venv",
	"target",
	".cache",
	".git",
	"tmp",
]);

export const DOC_EXTENSIONS = new Set([
	".md",
	".mdx",
	".markdown",
	".txt",
	".rst",
	".adoc",
]);

export const SECRET_EXCLUDE_GLOBS = [
	"**/.env*",
	"**/*secret*",
	"**/*.key*",
	"**/*credential*",
];

export const DEFAULT_MAX_BYTES = 1_000_000; // 1 MB; skip giant generated files

export interface SkippedFile {
	relPath: string;
	reason: "oversize" | "binary" | "non-utf8" | "symlink" | "unreadable";
}

export interface WalkResult {
	files: string[];
	skipped: SkippedFile[];
}

function looksBinary(buf: Buffer): boolean {
	const n = Math.min(buf.length, 8000);
	for (let i = 0; i < n; i++) if (buf[i] === 0) return true; // NUL byte => binary
	return false;
}

function isValidUtf8(buf: Buffer): boolean {
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(buf);
		return true;
	} catch {
		return false;
	}
}

export async function walkDocs(
	rootPath: string,
	opts: {
		includeGlobs?: string[];
		excludeGlobs?: string[];
		maxBytes?: number;
	} = {},
): Promise<WalkResult> {
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	const isIncluded = opts.includeGlobs?.length
		? picomatch(opts.includeGlobs)
		: null;
	const isOwnerExcluded = opts.excludeGlobs?.length
		? picomatch(opts.excludeGlobs)
		: null;
	const isSecretExcluded = picomatch(SECRET_EXCLUDE_GLOBS);
	const files: string[] = [];
	const skipped: SkippedFile[] = [];

	async function walk(absDir: string): Promise<void> {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(absDir, { withFileTypes: true });
		} catch {
			return; // unreadable sub-directory; skip (a missing/unreadable ROOT is caught by indexSource)
		}
		for (const entry of entries) {
			const abs = path.join(absDir, entry.name);
			const rel = path.relative(rootPath, abs).split(path.sep).join("/");
			if (entry.isSymbolicLink()) {
				skipped.push({ relPath: rel, reason: "symlink" }); // never follow (cycles, escapes)
				continue;
			}
			if (entry.isDirectory()) {
				if (PRUNE_DIRS.has(entry.name)) continue;
				await walk(abs);
				continue;
			}
			if (!entry.isFile()) continue;

			// Policy filters (intentional, silent): owner explicit excludes always win;
			// an owner include glob overrides the default secret excludes (spec: secret
			// excludes "which an owner may override"); non-doc files are dropped.
			if (isOwnerExcluded && isOwnerExcluded(rel)) continue;
			const matchesInclude = isIncluded ? isIncluded(rel) : false;
			if (isSecretExcluded(rel) && !matchesInclude) continue;
			const ext = path.extname(entry.name).toLowerCase();
			if (!(DOC_EXTENSIONS.has(ext) || matchesInclude)) continue;

			// Invalid-file guards: each skip is recorded with a reason (spec edge case).
			let buf: Buffer;
			try {
				const st = await fs.promises.stat(abs);
				if (st.size > maxBytes) {
					skipped.push({ relPath: rel, reason: "oversize" });
					continue;
				}
				buf = await fs.promises.readFile(abs);
			} catch {
				skipped.push({ relPath: rel, reason: "unreadable" });
				continue;
			}
			if (looksBinary(buf)) {
				skipped.push({ relPath: rel, reason: "binary" });
				continue;
			}
			if (!isValidUtf8(buf)) {
				skipped.push({ relPath: rel, reason: "non-utf8" });
				continue;
			}
			files.push(rel);
		}
	}

	await walk(rootPath);
	files.sort();
	return { files, skipped };
}
