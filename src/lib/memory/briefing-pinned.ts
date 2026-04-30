import { openRetrieve } from "./retrieve.js";
import { loadMemoryConfig } from "./config.js";

export async function renderPinnedSection(
	repoKey: string,
): Promise<string | null> {
	const cfg = await loadMemoryConfig(repoKey);
	const rh = openRetrieve(repoKey);
	try {
		const explicit = rh.index
			.rawDb()
			.prepare(
				`
            SELECT id, type, status, title, body_excerpt AS bodyExcerpt, updated_at AS updatedAt, confidence
            FROM memories
            WHERE status='active' AND pinned=1
        `,
			)
			.all() as Array<{
			id: string;
			type: string;
			status: string;
			title: string;
			bodyExcerpt: string;
			updatedAt: string;
			confidence: number;
		}>;

		const auto = rh.index
			.rawDb()
			.prepare(
				`
            SELECT id, type, status, title, body_excerpt AS bodyExcerpt, updated_at AS updatedAt, confidence
            FROM memories
            WHERE status='active' AND pinned=0
              AND type IN ('decision','gotcha')
              AND confidence >= 0.9
              AND NOT EXISTS (SELECT 1 FROM memory_scope s WHERE s.memory_id=memories.id AND s.kind='file')
        `,
			)
			.all() as Array<{
			id: string;
			type: string;
			status: string;
			title: string;
			bodyExcerpt: string;
			updatedAt: string;
			confidence: number;
		}>;

		const all = [...explicit, ...auto];
		all.sort((a, b) => {
			const ageA = (Date.now() - new Date(a.updatedAt).getTime()) / 86400e3;
			const ageB = (Date.now() - new Date(b.updatedAt).getTime()) / 86400e3;
			const sa = a.confidence * Math.exp(-ageA / 60);
			const sb = b.confidence * Math.exp(-ageB / 60);
			return sb - sa;
		});

		const top = all.slice(0, cfg.injection.autoInjectTopK);
		if (top.length === 0) return null;

		const lines: string[] = [`## Pinned memories (${top.length})`, ""];
		for (const m of top) {
			lines.push(`- **${m.type}** — ${m.title}`);
			lines.push(`  > ${m.bodyExcerpt} (${m.id})`);
			lines.push("");
		}
		return lines.join("\n");
	} finally {
		rh.close();
	}
}
