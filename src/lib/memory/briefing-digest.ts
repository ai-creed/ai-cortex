// src/lib/memory/briefing-digest.ts
import { openRetrieve } from "./retrieve.js";

type DigestRow = {
	id: string;
	type: string;
	title: string;
	confidence: number;
	scope: string;
};

const TOP_PER_TYPE = 5;

export async function renderMemoryDigest(
	repoKey: string,
): Promise<string | null> {
	const rh = openRetrieve(repoKey);
	try {
		const db = rh.index.rawDb();

		const counts = db
			.prepare(
				`SELECT
					SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
					SUM(CASE WHEN status='candidate' THEN 1 ELSE 0 END) AS candidate,
					SUM(CASE WHEN status='active' AND pinned=1 THEN 1 ELSE 0 END) AS pinned
				FROM memories`,
			)
			.get() as { active: number; candidate: number; pinned: number };

		if ((counts.active ?? 0) === 0 && (counts.candidate ?? 0) === 0) {
			return null;
		}

		// Type-agnostic: query DISTINCT types actually present in the store
		// instead of hardcoding the built-in list. User-registered types
		// (added via types.json) participate without code changes.
		const typeRows = db
			.prepare(
				`SELECT type, COUNT(*) AS n FROM memories
				 WHERE status='active'
				 GROUP BY type
				 ORDER BY n DESC, type ASC`,
			)
			.all() as Array<{ type: string; n: number }>;

		const lines: string[] = [];
		lines.push(
			`## Memory available — ${counts.active ?? 0} active, ${counts.candidate ?? 0} candidates, ${counts.pinned ?? 0} pinned`,
		);
		lines.push("");

		for (const { type } of typeRows) {
			const rows = db
				.prepare(
					`SELECT m.id, m.type, m.title, m.confidence,
						COALESCE(GROUP_CONCAT(s.value, ', '), '') AS scope
					FROM memories m
					LEFT JOIN memory_scope s ON s.memory_id = m.id AND s.kind = 'file'
					WHERE m.status='active' AND m.type=?
					GROUP BY m.id
					ORDER BY m.confidence DESC, m.updated_at DESC
					LIMIT ?`,
				)
				.all(type, TOP_PER_TYPE) as DigestRow[];
			if (rows.length === 0) continue;
			lines.push(`### ${capitalize(type)} (top ${rows.length})`);
			for (const r of rows) {
				const scope = r.scope ? ` [${truncate(r.scope, 40)}]` : "";
				const conf = r.confidence.toFixed(2);
				lines.push(`- ${truncate(r.title, 80)}${scope} (${conf})`);
			}
			lines.push("");
		}

		const pendingCount = (
			db
				.prepare(
					`SELECT COUNT(*) AS n FROM memories
					 WHERE status = 'candidate' AND rewritten_at IS NULL`,
				)
				.get() as { n: number }
		).n;

		if (pendingCount > 0) {
			lines.push(`## Pending review — ${pendingCount} candidates eligible for cleanup`);
			lines.push("");
			lines.push(
				"Candidates are raw extracted bodies. Rewriting promotes them to `active` and produces clean rule cards that recall can return without further interpretation.",
			);
			lines.push("");
			lines.push(
				"- `list_memories_pending_rewrite({worktreePath})` — fetch the queue (max 25 per call; pass `since` for incremental passes)",
			);
			lines.push(
				"- dispatch a subagent with the result as context → have it rewrite each as a rule card (title + rule + when-applies) → call `rewrite_memory` per item to commit",
			);
			lines.push(
				"- for items that turn out to not be rules (one-off directives, transcript fragments without a recurring pattern), call `deprecate_memory` instead",
			);
			lines.push("");
			lines.push(
				"Cleanup is opt-in. Candidates age out at 90d if untouched.",
			);
			lines.push("");
		}

		lines.push("### How to consult");
		lines.push(
			"- For work in `src/<area>`, call `recall_memory` with `scope.files` to filter to relevant memories.",
		);
		lines.push(
			"- For cross-project patterns (language quirks, tool gotchas), pass `source: 'all'`.",
		);
		lines.push(
			"- After `recall_memory` returns a relevant hit, call `get_memory(id)` to fetch the full record before applying the rule. `get_memory` bumps an access counter and last-access timestamp; `recall_memory` is browse-only.",
		);
		lines.push(
			"- If a recalled memory contradicts current code, call `deprecate_memory(id, reason)`.",
		);
		lines.push("");

		return lines.join("\n");
	} finally {
		rh.close();
	}
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function truncate(s: string, n: number): string {
	const oneline = s.replace(/\s+/g, " ").trim();
	return oneline.length <= n ? oneline : oneline.slice(0, n - 1) + "…";
}
