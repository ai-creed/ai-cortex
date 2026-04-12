// src/lib/suggest-ranker.ts
import type { RepoCache } from "./models.js";

export type RankSuggestionsOptions = {
	from?: string | null;
	limit?: number;
};

export type RankedSuggestion = {
	path: string;
	kind: "file" | "doc";
	score: number;
	reason: string;
};

function tokenize(value: string): string[] {
	return [...new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))];
}

function normalizePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\.?\//, "");
}

function stripKnownExt(value: string): string {
	return value.replace(/\.(ts|tsx|js|jsx|md)$/u, "");
}

function sameDirectory(a: string, b: string): boolean {
	return a.split("/").slice(0, -1).join("/") === b.split("/").slice(0, -1).join("/");
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
	const tokens = tokenize(task);
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

	const candidates: RankedSuggestion[] = [];

	for (const file of cache.files) {
		if (docPathSet.has(file.path)) continue;

		const normalizedPath = normalizePath(file.path);
		const pathTokens = tokenize(normalizedPath);
		const matchedPathTokens = tokens.filter((token) => pathTokens.includes(token));
		let score = matchedPathTokens.length * 5;

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

		if (score > 0) {
			candidates.push({
				path: file.path,
				kind: "file",
				score,
				reason:
					matchedPathTokens.length > 0
						? `matched task terms in path: ${matchedPathTokens.join(", ")}`
						: normalizedFrom && sameDirectory(normalizedPath, normalizedFrom) && normalizedPath !== normalizedFrom
							? "near anchor file via path"
							: cache.entryFiles.includes(file.path)
								? "entry file with matching repo context"
								: "near anchor file via imports",
			});
		}
	}

	for (const doc of cache.docs) {
		const docTokens = tokenize(`${doc.title} ${doc.body} ${doc.path}`);
		const matchedDocTokens = tokens.filter((token) => docTokens.includes(token));
		const score = matchedDocTokens.length * 4;
		if (score > 0) {
			candidates.push({
				path: doc.path,
				kind: "doc",
				score,
				reason: "doc title/body strongly matches task",
			});
		}
	}

	return candidates
		.sort(
			(a, b) =>
				b.score - a.score ||
				(a.kind === b.kind ? 0 : a.kind === "file" ? -1 : 1) ||
				a.path.localeCompare(b.path),
		)
		.slice(0, options.limit ?? 5);
}
