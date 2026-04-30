// src/lib/memory/cli/deprecate.ts
import { openLifecycle, deprecateMemory } from "../lifecycle.js";

type DeprecateArgs = { id: string; reason: string };

function parseDeprecateArgs(args: string[]): DeprecateArgs {
	let id: string | undefined;
	let reason: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--reason" && args[i + 1]) { reason = args[++i]; continue; }
		if (!a.startsWith("--") && !id) { id = a; continue; }
	}
	if (!id) throw new Error("required: <id>");
	if (!reason) throw new Error("required: --reason");
	return { id, reason };
}

export async function runMemoryDeprecate(args: string[], opts: {
	repoKey: string;
	stdout?: NodeJS.WriteStream;
} = { repoKey: "" }): Promise<number> {
	try {
		const parsed = parseDeprecateArgs(args);
		const lc = await openLifecycle(opts.repoKey, { agentId: "cli-user" });
		try {
			await deprecateMemory(lc, parsed.id, parsed.reason);
			(opts.stdout ?? process.stdout).write("ok\n");
			return 0;
		} finally {
			lc.close();
		}
	} catch (err) {
		process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
		return 1;
	}
}
