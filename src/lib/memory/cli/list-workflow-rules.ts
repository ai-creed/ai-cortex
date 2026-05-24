// src/lib/memory/cli/list-workflow-rules.ts
import { resolveRepoIdentity } from "../../repo-identity.js";
import { openMemoryIndex } from "../index.js";
import {
	selectWorkflowRules,
	formatWorkflowRulesText,
} from "../workflow-rules.js";

const DEFAULT_LIMIT = (() => {
	const env = process.env.AI_CORTEX_WORKFLOW_LIST_CAP;
	const parsed = env ? Number.parseInt(env, 10) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
})();

export type RunListOpts = {
	cwd?: string;
	repoKey?: string;
	limit?: number;
	format?: "text" | "json" | "hook";
	stdout?: { write: (s: string) => boolean };
};

export async function runListWorkflowRules(opts: RunListOpts): Promise<number> {
	const stdout = opts.stdout ?? process.stdout;
	const format = opts.format ?? "text";
	const limit = opts.limit ?? DEFAULT_LIMIT;

	let repoKey: string;
	try {
		repoKey =
			opts.repoKey ??
			resolveRepoIdentity(opts.cwd ?? process.cwd()).repoKey;
	} catch {
		if (format === "hook") {
			stdout.write(
				JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "SessionStart",
					},
				}) + "\n",
			);
		} else if (format === "json") {
			stdout.write("[]\n");
		} else {
			stdout.write("");
		}
		return 0;
	}

	const idx = openMemoryIndex(repoKey);
	let rules;
	try {
		rules = selectWorkflowRules(idx, limit);
	} finally {
		idx.close();
	}

	if (format === "json") {
		stdout.write(JSON.stringify(rules) + "\n");
		return 0;
	}
	if (format === "hook") {
		const body = formatWorkflowRulesText(rules);
		const payload: { hookSpecificOutput: Record<string, unknown> } = {
			hookSpecificOutput: { hookEventName: "SessionStart" },
		};
		if (body) payload.hookSpecificOutput.additionalContext = body;
		stdout.write(JSON.stringify(payload) + "\n");
		return 0;
	}
	// text
	const body = formatWorkflowRulesText(rules);
	stdout.write(body);
	if (body && !body.endsWith("\n")) stdout.write("\n");
	return 0;
}
