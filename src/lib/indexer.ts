// src/lib/indexer.ts
import fs from "node:fs";
import path from "node:path";
import {
	buildRepoFingerprint,
	computeContentFingerprint,
	readCacheForWorktree,
	writeCache,
} from "./cache-store.js";
import {
	extractCallGraph,
	extractCallGraphRaw,
	resolveCallSites,
	stripTsExt,
} from "./call-graph.js";
import { isAdapterExt } from "./adapters/index.js";
import { ensureAdapters } from "./adapters/ensure.js";
import { hashFileContent } from "./diff-files.js";
import type { FilesDiff } from "./diff-files.js";
import { loadDocs } from "./doc-inputs.js";
import { readPackageMeta, pickEntryFiles } from "./entry-files.js";
import { extractImports } from "./import-graph.js";
import { listIndexableFiles } from "./indexable-files.js";
import { SCHEMA_VERSION, IndexError, RepoIdentityError } from "./models.js";
import type {
	CallEdge,
	ImportEdge,
	ReexportRow,
	RefEdge,
	RepoCache,
	RepoIdentity,
	SymbolNode,
} from "./models.js";
import { resolveRepoIdentity } from "./repo-identity.js";
import { resolveRefs } from "./symbol-resolver.js";
import { functionsFromSymbols } from "./symbols.js";

type FileContentMap = Map<string, string>;

function readFileContents(
	worktreePath: string,
	filePaths: string[],
): FileContentMap {
	const map: FileContentMap = new Map();
	for (const filePath of filePaths) {
		try {
			const content = fs.readFileSync(
				path.join(worktreePath, filePath),
				"utf8",
			);
			map.set(filePath, content);
		} catch {
			// skip unreadable files
		}
	}
	return map;
}

export async function buildIndex(identity: RepoIdentity): Promise<RepoCache> {
	try {
		const filePaths = await listIndexableFiles(identity.worktreePath);
		const contentMap = readFileContents(identity.worktreePath, filePaths);
		const packageMeta = await readPackageMeta(identity.worktreePath);
		const entryFiles = pickEntryFiles(filePaths, packageMeta);
		const docs = loadDocs(identity.worktreePath, filePaths);
		const imports = await extractImports(
			identity.worktreePath,
			filePaths,
			filePaths,
			contentMap,
		);
		const fingerprint = await buildRepoFingerprint(identity.worktreePath);
		const files = filePaths.map((p) => ({
			path: p,
			kind: "file" as const,
			contentHash: hashFileContent(identity.worktreePath, p, contentMap.get(p)),
		}));
		const {
			calls,
			functions: functionNodes,
			symbols,
			refs,
			reexports,
		} = await extractCallGraph(identity.worktreePath, filePaths, contentMap);

		return {
			schemaVersion: SCHEMA_VERSION,
			repoKey: identity.repoKey,
			worktreeKey: identity.worktreeKey,
			worktreePath: identity.worktreePath,
			indexedAt: new Date().toISOString(),
			fingerprint,
			indexSeq: 0,
			contentFingerprint: computeContentFingerprint(files),
			packageMeta,
			entryFiles,
			files,
			docs,
			imports,
			calls,
			functions: functionNodes,
			symbols,
			refs,
			reexports,
		};
	} catch (err) {
		if (err instanceof RepoIdentityError) throw err;
		const msg = err instanceof Error ? err.message : String(err);
		throw new IndexError(msg);
	}
}

export async function indexRepo(repoPath: string): Promise<RepoCache> {
	const identity = resolveRepoIdentity(repoPath);
	const cache = await buildIndex(identity);
	await writeCache(cache);
	return cache;
}

export async function buildIncrementalIndex(
	identity: RepoIdentity,
	existingCache: RepoCache,
	diff: FilesDiff,
	dirtyAtIndex: boolean,
): Promise<RepoCache> {
	await ensureAdapters();

	const fingerprint = await buildRepoFingerprint(identity.worktreePath);
	const indexedAt = new Date().toISOString();

	// Empty diff: timestamp-only refresh. The writer assigns indexSeq.
	if (diff.changed.length === 0 && diff.removed.length === 0) {
		return {
			...existingCache,
			fingerprint,
			indexedAt,
			dirtyAtIndex,
			indexSeq: 0,
			contentFingerprint: computeContentFingerprint(existingCache.files),
			calls: existingCache.calls ?? [],
			functions: existingCache.functions ?? [],
			symbols: existingCache.symbols ?? [],
			refs: existingCache.refs ?? [],
			reexports: existingCache.reexports ?? [],
		};
	}

	const changedSet = new Set(diff.changed);
	const removedSet = new Set(diff.removed);
	const touchedSet = new Set([...diff.changed, ...diff.removed]);

	// --- files[] ---
	const keptFiles = existingCache.files.filter(
		(f) => !changedSet.has(f.path) && !removedSet.has(f.path),
	);
	const newFiles = diff.changed.map((p) => ({
		path: p,
		kind: "file" as const,
		contentHash: hashFileContent(identity.worktreePath, p),
	}));
	const files = [...keptFiles, ...newFiles].sort((a, b) =>
		a.path.localeCompare(b.path),
	);
	const allFilePaths = files.map((f) => f.path);

	// --- imports[] ---
	const keptImports = existingCache.imports.filter(
		(e) => !changedSet.has(e.from) && !removedSet.has(e.from),
	);
	const changedAdapterFiles = diff.changed.filter(isAdapterExt);
	const newImports = await extractImports(
		identity.worktreePath,
		changedAdapterFiles,
		allFilePaths,
	);
	const imports = [...keptImports, ...newImports];

	// --- packageMeta ---
	const packageJsonTouched =
		changedSet.has("package.json") || removedSet.has("package.json");
	const packageMeta = packageJsonTouched
		? await readPackageMeta(identity.worktreePath)
		: existingCache.packageMeta;

	// --- entryFiles[] ---
	const entryFiles = pickEntryFiles(allFilePaths, packageMeta);

	// --- docs[] ---
	const anyMdTouched = [...touchedSet].some((p) => p.endsWith(".md"));
	const docs = anyMdTouched
		? loadDocs(identity.worktreePath, allFilePaths)
		: existingCache.docs;

	// --- calls, functions, symbols, refs, reexports ---
	const existingCalls = existingCache.calls ?? [];
	const existingSymbols = existingCache.symbols ?? [];
	const existingRefs = existingCache.refs ?? [];
	const existingReexports = existingCache.reexports ?? [];

	// Keep rows for files outside the affected set.
	const affected = computeAffectedFiles(
		existingCache.imports,
		touchedSet,
		existingReexports,
	);
	const cleanSet = new Set([...touchedSet, ...affected]);
	const keptCalls = existingCalls.filter(
		(e) => !cleanSet.has(fileOfKey(e.from)),
	);
	const keptSymbols = existingSymbols.filter((s) => !cleanSet.has(s.file));
	const keptRefs = existingRefs.filter((r) => !cleanSet.has(r.file));
	const keptReexports = existingReexports.filter((r) => !cleanSet.has(r.file));

	// Reparse touched plus affected files.
	const filesToReparse = [
		...changedAdapterFiles,
		...[...affected].filter(isAdapterExt),
	];
	const {
		rawCalls,
		rawRefs,
		symbols: newSymbols,
		reexports: newReexports,
		bindingsByFile,
	} = await extractCallGraphRaw(identity.worktreePath, filesToReparse);

	// Merge, then re-resolve against the merged symbols and re-export rows.
	const symbols = [...keptSymbols, ...newSymbols];
	const reexports = [...keptReexports, ...newReexports];
	const functionNodes = functionsFromSymbols(symbols);
	const includesByFile = new Map<string, ImportEdge[]>();
	for (const edge of imports) {
		const list = includesByFile.get(edge.from) ?? [];
		list.push(edge);
		includesByFile.set(edge.from, list);
	}
	const newCalls = resolveCallSites(
		rawCalls,
		functionNodes,
		bindingsByFile,
		includesByFile,
		symbols,
		reexports,
	);
	const newRefs = resolveRefs(
		rawRefs,
		symbols,
		bindingsByFile,
		reexports,
		includesByFile,
	);

	// Sweep kept rows that still point at keys no longer in symbols.
	const { refs, calls } = sweepStaleKeys(
		[...keptRefs, ...newRefs],
		[...keptCalls, ...newCalls],
		symbols,
	);

	return {
		schemaVersion: SCHEMA_VERSION,
		repoKey: identity.repoKey,
		worktreeKey: identity.worktreeKey,
		worktreePath: identity.worktreePath,
		indexedAt,
		fingerprint,
		dirtyAtIndex,
		indexSeq: 0,
		contentFingerprint: computeContentFingerprint(files),
		packageMeta,
		entryFiles,
		files,
		docs,
		imports,
		calls,
		functions: functionNodes,
		symbols,
		refs,
		reexports,
	};
}

function fileOfKey(key: string): string {
	return key.slice(0, key.indexOf("::"));
}

function importEdgeTargets(edgeTo: string, file: string): boolean {
	const stripped = stripTsExt(file);
	return (
		edgeTo === stripped ||
		edgeTo === stripped.replace(/\/index$/, "") ||
		edgeTo === file
	);
}

/**
 * Untouched files whose rows must be rebuilt: importers of a touched file,
 * plus one re-export hop (importers of a touched or affected file that has
 * `reexports` rows in the existing cache).
 */
function computeAffectedFiles(
	existingImports: ImportEdge[],
	touchedSet: Set<string>,
	existingReexports: ReexportRow[],
): Set<string> {
	const importersOf = (targets: string[], skip: Set<string>): string[] => {
		const out: string[] = [];
		for (const edge of existingImports) {
			if (skip.has(edge.from)) continue;
			if (targets.some((t) => importEdgeTargets(edge.to, t))) {
				out.push(edge.from);
			}
		}
		return out;
	};

	const affected = new Set(importersOf([...touchedSet], touchedSet));
	const filesWithReexports = new Set(existingReexports.map((r) => r.file));
	const hopTargets = [...touchedSet, ...affected].filter((f) =>
		filesWithReexports.has(f),
	);
	const skip = new Set([...touchedSet, ...affected]);
	for (const f of importersOf(hopTargets, skip)) affected.add(f);
	return affected;
}

/**
 * Guarantees no dangling key: a ref or call whose target is absent from
 * `symbols` becomes unresolved. Chains longer than the one-hop rule land here.
 */
function sweepStaleKeys(
	refs: RefEdge[],
	calls: CallEdge[],
	symbols: SymbolNode[],
): { refs: RefEdge[]; calls: CallEdge[] } {
	const liveKeys = new Set(symbols.map((s) => `${s.file}::${s.qualifiedName}`));
	const sweptRefs = refs.map((r) => {
		if (r.to === undefined || liveKeys.has(r.to)) return r;
		const { to: _stale, ...rest } = r;
		return rest;
	});
	const sweptCalls = calls.map((e) => {
		if (e.to.startsWith("::") || liveKeys.has(e.to)) return e;
		return { ...e, to: `::${e.to.slice(e.to.indexOf("::") + 2)}` };
	});
	return { refs: sweptRefs, calls: sweptCalls };
}

export async function getCachedIndex(
	repoPath: string,
): Promise<RepoCache | null> {
	const identity = resolveRepoIdentity(repoPath);
	const cached = await readCacheForWorktree(
		identity.repoKey,
		identity.worktreeKey,
	);
	if (!cached) return null;
	const currentFingerprint = await buildRepoFingerprint(identity.worktreePath);
	if (cached.fingerprint !== currentFingerprint) return null;
	return cached;
}
