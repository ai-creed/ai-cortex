// src/lib/library/value.ts
import type { ValueSignal } from "./types.js";

export function deriveDocType(relPath: string): string {
	const p = relPath.toLowerCase();
	if (p.includes("/specs/") || p.endsWith("-design.md")) return "spec";
	if (p.includes("/deliberations/")) return "deliberation";
	if (p.includes("/plans/")) return "plan";
	if (p.includes("/ideas/")) return "idea";
	if (/(^|\/)readme\.(md|mdx|markdown|txt)$/.test(p)) return "readme";
	return "doc";
}

export function parseStatusHeader(text: string): string | undefined {
	const lines = text.split(/\r?\n/).slice(0, 20);
	for (const line of lines) {
		const m = /^\s*(?:status|version)\s*:\s*(.+?)\s*$/i.exec(line);
		if (m) return m[1];
	}
	return undefined;
}

const DOC_TYPE_RANK: Record<string, number> = {
	spec: 0.06,
	deliberation: 0.06,
	plan: 0.05,
	readme: 0.04,
	doc: 0.02,
	idea: 0.01,
};

// Returns an additive weight in [0, 0.10], the same magnitude as the origin
// boost, so neither dominates the normalized fused score.
export function valueWeight(v: ValueSignal): number {
	let w = DOC_TYPE_RANK[v.docType] ?? 0.02;
	if (v.pinned) w += 0.04;
	if (v.statusHeader) w += 0.01;
	return Math.min(w, 0.1);
}
