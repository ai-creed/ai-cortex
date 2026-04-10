// src/lib/briefing.ts
import type { RepoCache } from "./models.js";

function renderHeader(cache: RepoCache): string {
	const parts: string[] = [];
	if (cache.packageMeta.framework) {
		parts.push(`**Framework:** ${cache.packageMeta.framework}`);
	}
	parts.push(`**Version:** ${cache.packageMeta.version}`);
	parts.push(`**Files:** ${cache.files.length}`);
	parts.push(`**Indexed:** ${cache.indexedAt}`);
	return `# ${cache.packageMeta.name}\n\n${parts.join(" · ")}\n`;
}

function renderKeyDocs(cache: RepoCache): string {
	const lines = cache.docs
		.slice(0, 3)
		.map((doc) => `- \`${doc.path}\` — ${doc.title}`);
	return `## Key Docs\n\n${lines.join("\n")}\n`;
}

function renderEntryFiles(cache: RepoCache): string {
	const lines = cache.entryFiles.slice(0, 6).map((f) => `- \`${f}\``);
	return `## Entry Files\n\n${lines.join("\n")}\n`;
}

const IGNORE_DIRS = new Set([
	"node_modules",
	"dist",
	"out",
	"build",
	"release",
	".git",
]);

function renderDirectoryStructure(cache: RepoCache): string {
	const dirs = new Map<string, Set<string>>();

	for (const file of cache.files) {
		const parts = file.path.split("/");
		if (parts.length < 2) continue;
		const topDir = parts[0];
		if (IGNORE_DIRS.has(topDir)) continue;
		if (!dirs.has(topDir)) dirs.set(topDir, new Set());
		if (parts.length >= 3) {
			dirs.get(topDir)!.add(parts[1]);
		}
	}

	const sortedTop = [...dirs.keys()].sort();
	const lines: string[] = [];
	for (const top of sortedTop) {
		lines.push(`${top}/`);
		const subs = [...dirs.get(top)!].sort();
		for (const sub of subs) {
			lines.push(`  ${sub}/`);
		}
	}

	return `## Directory Structure\n\n${lines.join("\n")}\n`;
}

function renderImportHotSpots(cache: RepoCache): string | null {
	if (cache.imports.length === 0) return null;

	const counts = new Map<string, number>();
	for (const edge of cache.imports) {
		counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1);
	}

	const sorted = [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5);

	const lines = sorted.map(
		([target, count]) => `- \`${target}\` (${count} importers)`,
	);

	return (
		"## Import Hot Spots\n\n" +
		"Files with the most inbound imports (likely core modules):\n\n" +
		lines.join("\n") +
		"\n"
	);
}

export function renderBriefing(cache: RepoCache): string {
	const sections: string[] = [
		renderHeader(cache),
		renderKeyDocs(cache),
		renderEntryFiles(cache),
		renderDirectoryStructure(cache),
	];

	const hotSpots = renderImportHotSpots(cache);
	if (hotSpots) sections.push(hotSpots);

	return sections.join("\n");
}
