// src/lib/memory/workflow-rules.ts
//
// Pure selection + text-formatter for the Prong B SessionStart workflow-rules
// surface (spec 2026-05-24 §5). Consumed by:
//   - src/lib/memory/cli/list-workflow-rules.ts
//   - src/lib/memory/briefing-workflow-rules.ts (rehydrate fallback)

import type { MemoryIndex } from "./index.js";

export type WorkflowRule = {
	id: string;
	title: string;
	type: string;
};

type Row = {
	id: string;
	title: string;
	type: string;
};

export function selectWorkflowRules(
	index: MemoryIndex,
	limit: number,
): WorkflowRule[] {
	const rows = index
		.rawDb()
		.prepare(
			`
            SELECT m.id, m.title, m.type
            FROM memories m
            WHERE m.status = 'active'
              AND m.type IN ('decision', 'how-to')
              AND NOT EXISTS (
                SELECT 1 FROM memory_scope s
                WHERE s.memory_id = m.id AND s.kind = 'file'
              )
              AND EXISTS (
                SELECT 1 FROM memory_scope s
                WHERE s.memory_id = m.id AND s.kind = 'tag'
              )
            ORDER BY m.pinned DESC, m.get_count DESC, m.updated_at DESC, m.id ASC
            LIMIT ?
        `,
		)
		.all(limit) as Row[];
	return rows.map((r) => ({ id: r.id, title: r.title, type: r.type }));
}

export function formatWorkflowRulesText(rules: WorkflowRule[]): string {
	if (rules.length === 0) return "";
	const lines: string[] = [];
	lines.push(`## Workflow rules — ${rules.length} active`);
	lines.push("");
	for (const r of rules) lines.push(`- [${r.id}] ${r.title} (${r.type})`);
	lines.push("");
	lines.push("Call `get_memory(id)` to consult any rule before doing relevant work.");
	lines.push("Surfaced ≠ relevant — do NOT get_memory ones that do not apply.");
	return lines.join("\n");
}
