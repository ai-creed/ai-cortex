import type { RepoCache, SuggestResult } from "./models.js";

function tokenize(input: string): string[] {
	return input
		.toLowerCase()
		.split(/[^a-z0-9]+/u)
		.filter(Boolean);
}

export function suggestFiles(task: string, cache: RepoCache, limit = 5): SuggestResult[] {
	const terms = tokenize(task);
	const docText = cache.docs
		.map(doc => `${doc.path} ${doc.title} ${doc.body}`.toLowerCase())
		.join("\n");

	return cache.files
		.filter(node => node.kind === "file")
		.map(node => {
			const pathLower = node.path.toLowerCase();
			const pathTokens = new Set(tokenize(pathLower));
			const isMarkdown = pathLower.endsWith(".md");
			let score = 0;
			for (const term of terms) {
				if (pathTokens.has(term)) score += 3;
				if (docText.includes(term) && pathTokens.has(term)) score += 2;
			}
			if (isMarkdown) score -= 2;
			return {
				path: node.path,
				score,
				reason: terms.filter(term => pathTokens.has(term)).slice(0, 2).join(", ")
			};
		})
		.filter(item => item.score > 0)
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
		.slice(0, limit)
		.map(item => ({
			path: item.path,
			reason: item.reason ? `matched task terms: ${item.reason}` : "matched repo context"
		}));
}
