// benchmarks/eval/metrics.ts

const EXPLORATION_TOOLS = new Set(["Read", "Grep", "Glob", "Bash", "Agent", "Skill"]);
const MUTATION_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

export type ParsedMetrics = {
	explorationCalls: number;
	totalToolCalls: number;
	durationMs: number;
};

export function parseStreamJson(output: string): ParsedMetrics {
	const lines = output.split("\n").filter((l) => l.trim().length > 0);

	let totalToolCalls = 0;
	let firstMutationIdx = -1;
	let durationMs = 0;

	for (const line of lines) {
		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}

		if (obj.type === "result") {
			durationMs = typeof obj.duration_ms === "number" ? obj.duration_ms : 0;
			continue;
		}

		if (obj.type !== "assistant") continue;

		const message = obj.message as { content?: unknown[] } | undefined;
		if (!message?.content) continue;

		for (const block of message.content) {
			const b = block as Record<string, unknown>;
			if (b.type !== "tool_use") continue;

			const name = b.name as string;
			if (!EXPLORATION_TOOLS.has(name) && !MUTATION_TOOLS.has(name)) continue;

			totalToolCalls++;

			if (firstMutationIdx < 0 && MUTATION_TOOLS.has(name)) {
				firstMutationIdx = totalToolCalls - 1;
			}
		}
	}

	const explorationCalls = firstMutationIdx < 0 ? totalToolCalls : firstMutationIdx;

	return { explorationCalls, totalToolCalls, durationMs };
}
