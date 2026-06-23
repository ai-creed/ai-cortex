// src/lib/library/source-registry.ts
import fs from "node:fs";
import path from "node:path";
import { resolveRepoIdentity } from "../repo-identity.js";
import { libraryRoot, sourcesJsonPath } from "./paths.js";
import type { SourceKind, SourceOrigin, SourceRecord } from "./types.js";
import { hashId } from "./util/ids.js";

function readAll(): SourceRecord[] {
	try {
		const raw = fs.readFileSync(sourcesJsonPath(), "utf8");
		return JSON.parse(raw) as SourceRecord[];
	} catch {
		return [];
	}
}

function writeAll(sources: SourceRecord[]): void {
	fs.mkdirSync(libraryRoot(), { recursive: true });
	const tmp = sourcesJsonPath() + ".tmp";
	fs.writeFileSync(tmp, JSON.stringify(sources, null, 2), "utf8");
	fs.renameSync(tmp, sourcesJsonPath());
}

function detectOrigin(
	rootPath: string,
	label?: string,
): { kind: SourceKind; origin: SourceOrigin } {
	const name = label ?? path.basename(rootPath);
	try {
		const { repoKey } = resolveRepoIdentity(rootPath);
		return { kind: "repo", origin: { repoKey, name } };
	} catch {
		return { kind: "dir", origin: { name } };
	}
}

function overlaps(a: string, b: string): boolean {
	const ap = a.endsWith(path.sep) ? a : a + path.sep;
	const bp = b.endsWith(path.sep) ? b : b + path.sep;
	return ap === bp || ap.startsWith(bp) || bp.startsWith(ap);
}

export function registerSource(opts: {
	rootPath: string;
	label?: string;
	include?: string[];
	exclude?: string[];
	nowIso: string;
}): { source: SourceRecord; warnings: string[] } {
	const rootPath = fs.realpathSync(path.resolve(opts.rootPath));
	const warnings: string[] = [];
	const existing = readAll();

	for (const s of existing) {
		if (overlaps(rootPath, s.rootPath)) {
			warnings.push(
				`overlap: ${rootPath} overlaps already-registered source ${s.rootPath} (${s.id}); double-indexing may occur`,
			);
		}
	}

	const id = hashId(rootPath);
	const { kind, origin } = detectOrigin(rootPath, opts.label);
	const source: SourceRecord = {
		id,
		rootPath,
		kind,
		origin,
		includeGlobs: opts.include ?? [],
		excludeGlobs: opts.exclude ?? [],
		addedAt: opts.nowIso,
		lastIndexedAt: null,
		status: "ok",
	};

	const next = existing.filter((s) => s.id !== id);
	next.push(source);
	writeAll(next);
	return { source, warnings };
}

export function listSources(): SourceRecord[] {
	return readAll();
}

export function getSource(id: string): SourceRecord | null {
	return readAll().find((s) => s.id === id) ?? null;
}

export function removeSource(id: string): boolean {
	const all = readAll();
	const next = all.filter((s) => s.id !== id);
	if (next.length === all.length) return false;
	writeAll(next);
	return true;
}

export function updateSource(
	id: string,
	patch: Partial<SourceRecord>,
): SourceRecord | null {
	const all = readAll();
	const idx = all.findIndex((s) => s.id === id);
	if (idx === -1) return null;
	const updated = { ...all[idx]!, ...patch, id: all[idx]!.id };
	all[idx] = updated;
	writeAll(all);
	return updated;
}
