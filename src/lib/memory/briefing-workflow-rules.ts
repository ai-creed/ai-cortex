// src/lib/memory/briefing-workflow-rules.ts
//
// Repo-keyed briefing extra for the workflow-rules section, gated on
// install-state of the SessionStart workflow hook. Mirrors the pattern of
// briefing-pinned.ts and briefing-digest.ts.
//
// When the SessionStart workflow-rules hook is installed, the SessionStart
// event already surfaces the list, so this section is suppressed (returns
// null) to avoid duplication. When the hook is NOT installed, the section
// acts as a fallback so workflow rules still reach the agent at rehydrate
// time.

import { sessionStartWorkflowHookInstalled } from "../history/hooks-install.js";
import { openMemoryIndex } from "./index.js";
import {
	selectWorkflowRules,
	formatWorkflowRulesText,
} from "./workflow-rules.js";

function readCap(): number {
	const env = process.env.AI_CORTEX_WORKFLOW_LIST_CAP;
	const n = env ? Number.parseInt(env, 10) : NaN;
	return Number.isFinite(n) && n > 0 ? n : 10;
}

export async function renderWorkflowRulesSection(
	repoKey: string,
	cli: "claude" | "codex" = "claude",
): Promise<string | null> {
	if (sessionStartWorkflowHookInstalled(cli)) return null;
	try {
		const idx = openMemoryIndex(repoKey);
		let rules;
		try {
			rules = selectWorkflowRules(idx, readCap());
		} finally {
			idx.close();
		}
		const body = formatWorkflowRulesText(rules);
		return body || null;
	} catch {
		return null;
	}
}
