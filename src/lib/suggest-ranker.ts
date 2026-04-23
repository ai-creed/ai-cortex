// src/lib/suggest-ranker.ts
import type { RepoCache } from "./models.js";
import { tokenize as tokenizePath, tokenizeTask } from "./tokenize.js";

export type RankSuggestionsOptions = {
	from?: string | null;
	limit?: number;
	/**
	 * When set, the final slice uses this value INSTEAD OF `limit`. Used by the
	 * deep ranker to request a large candidate pool regardless of the caller's
	 * user-facing `limit`. Deep then slices to `limit` itself at the very end.
	 * See docs/superpowers/specs/2026-04-15-ranker-fast-deep-design.md §7.2.
	 */
	poolSize?: number;
};

export type RankedSuggestion = {
	path: string;
	kind: "file" | "doc";
	score: number;
	reason: string;
};

function normalizePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\.?\//, "");
}

function stripKnownExt(value: string): string {
	return value.replace(/\.(ts|tsx|js|jsx|md)$/u, "");
}

function sameDirectory(a: string, b: string): boolean {
	return a.split("/").slice(0, -1).join("/") === b.split("/").slice(0, -1).join("/");
}

function fileFromCallKey(key: string): string {
	const idx = key.indexOf("::");
	return idx === -1 ? key : key.slice(0, idx);
}

function buildCallConnectedFiles(
	calls: { from: string; to: string }[],
): Map<string, Set<string>> {
	const connected = new Map<string, Set<string>>();
	for (const edge of calls) {
		if (edge.to.startsWith("::")) continue;
		const fromFile = fileFromCallKey(edge.from);
		const toFile = fileFromCallKey(edge.to);
		if (fromFile === toFile) continue;
		let fromSet = connected.get(fromFile);
		if (!fromSet) {
			fromSet = new Set();
			connected.set(fromFile, fromSet);
		}
		fromSet.add(toFile);
		let toSet = connected.get(toFile);
		if (!toSet) {
			toSet = new Set();
			connected.set(toFile, toSet);
		}
		toSet.add(fromFile);
	}
	return connected;
}

function buildFanInCounts(calls: { from: string; to: string }[]): Map<string, number> {
	const callersByTarget = new Map<string, Set<string>>();
	for (const edge of calls) {
		if (edge.to.startsWith("::")) continue;
		let callers = callersByTarget.get(edge.to);
		if (!callers) {
			callers = new Set();
			callersByTarget.set(edge.to, callers);
		}
		callers.add(edge.from);
	}
	const fanInByFile = new Map<string, number>();
	for (const [target, callers] of callersByTarget) {
		const file = fileFromCallKey(target);
		const current = fanInByFile.get(file) ?? 0;
		fanInByFile.set(file, Math.max(current, callers.size));
	}
	return fanInByFile;
}

function resolveImportTarget(target: string, filePaths: string[]): string[] {
	const normalizedTarget = normalizePath(target);
	return filePaths.filter((filePath) => {
		const normalizedFile = normalizePath(filePath);
		const stripped = stripKnownExt(normalizedFile);
		return (
			normalizedFile === normalizedTarget ||
			stripped === normalizedTarget ||
			stripped === `${normalizedTarget}/index`
		);
	});
}

export function rankSuggestions(
	task: string,
	cache: RepoCache,
	options: RankSuggestionsOptions = {},
): RankedSuggestion[] {
	const tokens = tokenizeTask(task);
	const normalizedFrom = options.from ? normalizePath(options.from) : null;
	const filePaths = cache.files.map((file) => file.path);
	const docPathSet = new Set(cache.docs.map((doc) => doc.path));
	const directTargets = normalizedFrom
		? [...cache.imports.filter((edge) => edge.from === normalizedFrom).map((edge) => edge.to)]
		: [];
	const directImporters = normalizedFrom
		? [
				...cache.imports
					.filter((edge) => {
						const matches = resolveImportTarget(edge.to, filePaths);
						return matches.length === 1 && matches[0] === normalizedFrom;
					})
					.map((edge) => edge.from),
			]
		: [];

	const calls = cache.calls ?? [];
	const callConnected = calls.length > 0 ? buildCallConnectedFiles(calls) : new Map();
	const fanInCounts = calls.length > 0 ? buildFanInCounts(calls) : new Map();

	const candidates: RankedSuggestion[] = [];

	for (const file of cache.files) {
		if (docPathSet.has(file.path)) continue;

		const normalizedPath = normalizePath(file.path);
		const pathTokens = tokenizePath(normalizedPath);
		const matchedPathTokens = tokens.filter((token) => pathTokens.includes(token));
		let score = matchedPathTokens.length * 5;

		// Basename bonus: when the filename (minus any single extension) is
		// *exactly* one of the query tokens, the file is the likely subject of
		// the task. Distinguishes `github.ts` from `github_apiwrappers.ts` etc.
		const basename = normalizedPath.split("/").pop() ?? "";
		const basenameNoExt = basename.replace(/\.[a-z]+$/u, "");
		if (basenameNoExt && tokens.includes(basenameNoExt)) score += 4;

		if (cache.entryFiles.includes(file.path)) score += 2;
		if (normalizedFrom && normalizedPath === normalizedFrom) score += 6;
		if (normalizedFrom && normalizedPath !== normalizedFrom && sameDirectory(normalizedPath, normalizedFrom)) score += 2;

		for (const target of directTargets) {
			const matches = resolveImportTarget(target, filePaths);
			if (matches.length === 1 && matches[0] === file.path) {
				score += 4;
			}
		}

		if (directImporters.includes(file.path)) {
			score += 4;
		}

		// Call graph: connected to anchor
		if (normalizedFrom && normalizedPath !== normalizedFrom) {
			const anchorConnections = callConnected.get(normalizedFrom);
			if (anchorConnections?.has(normalizedPath)) {
				score += 3;
			}
		}

		// Call graph: fan-in bonus
		const maxFanIn = fanInCounts.get(normalizedPath) ?? 0;
		if (maxFanIn > 5) {
			score += 1;
		}

		// Function name scoring — cap at 12 to prevent a single bag-o-functions file
		// from dominating a single well-named feature file.
		let fnScore = 0;
		for (const fn of cache.functions ?? []) {
			if (fn.file !== file.path) continue;
			const fnTokens = tokenizePath(fn.qualifiedName);
			const matched = tokens.filter((t) => fnTokens.includes(t)).length;
			if (matched === 0) continue;
			fnScore += matched * (fn.exported ? 3 : 1);
		}
		score += Math.min(fnScore, 12);

		if (score > 0) {
			const reasonParts: string[] = [];
			if (matchedPathTokens.length > 0) {
				reasonParts.push(`path:${matchedPathTokens.join(",")}`);
			}
			if (fnScore > 0) {
				const matchedFnNames = (cache.functions ?? [])
					.filter((fn) => fn.file === file.path)
					.filter((fn) => tokens.some((t) => tokenizePath(fn.qualifiedName).includes(t)))
					.map((fn) => fn.qualifiedName)
					.slice(0, 3);
				reasonParts.push(`fn:${matchedFnNames.join(",")}`);
			}

			const reason =
				reasonParts.length > 0
					? reasonParts.join(" | ")
					: normalizedFrom && normalizedPath === normalizedFrom
						? "anchor file"
						: normalizedFrom && sameDirectory(normalizedPath, normalizedFrom)
							? "near anchor file via path"
							: cache.entryFiles.includes(file.path)
								? "entry file with matching repo context"
								: "near anchor file via imports";

			candidates.push({
				path: file.path,
				kind: "file",
				score,
				reason,
			});
		}
	}

	// Second pass: boost files call-connected to the current top-scoring file
	if (calls.length > 0 && candidates.length > 0) {
		const sorted = [...candidates].sort((a, b) => b.score - a.score);
		const topPath = normalizePath(sorted[0].path);
		const topConnections = callConnected.get(topPath);
		if (topConnections) {
			// Boost existing candidates
			for (const candidate of candidates) {
				const candPath = normalizePath(candidate.path);
				if (candPath !== topPath && topConnections.has(candPath)) {
					candidate.score += 2;
				}
			}
			// Also add newly discovered connected files
			for (const file of cache.files) {
				if (docPathSet.has(file.path)) continue;
				const candPath = normalizePath(file.path);
				if (
					candPath !== topPath &&
					topConnections.has(candPath) &&
					!candidates.some((c) => normalizePath(c.path) === candPath)
				) {
					candidates.push({
						path: file.path,
						kind: "file",
						score: 2,
						reason: "call-connected to top-ranked file",
					});
				}
			}
		}
	}

	for (const doc of cache.docs) {
		const titleTokens = tokenizePath(doc.title);
		const pathTokensDoc = tokenizePath(doc.path);
		const bodyTokens = new Set(tokenizePath(doc.body));

		const titleMatches = tokens.filter((t) => titleTokens.includes(t)).length;
		const pathMatches = tokens.filter((t) => pathTokensDoc.includes(t)).length;
		const bodyMatches = tokens.filter((t) => bodyTokens.has(t)).length;

		// Body weight reduced from 2 → 1: body-only matches were dominating
		// path-matching files on large repos with many body-heavy `.md` files.
		const docScore = titleMatches * 8 + pathMatches * 5 + bodyMatches * 1;

		if (docScore > 0) {
			const parts: string[] = [];
			if (titleMatches > 0) parts.push("title");
			if (pathMatches > 0) parts.push("path");
			if (bodyMatches > 0) parts.push("body");
			candidates.push({
				path: doc.path,
				kind: "doc",
				score: docScore,
				reason: `doc match: ${parts.join("+")}`,
			});
		}
	}

	return candidates
		.sort(
			(a, b) =>
				b.score - a.score ||
				(a.kind === b.kind ? 0 : a.kind === "file" ? -1 : 1) ||
				a.path.length - b.path.length ||
				a.path.localeCompare(b.path),
		)
		.slice(0, options.poolSize ?? options.limit ?? 5);
}
