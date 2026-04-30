// src/lib/memory/cli/purge.ts
import { openLifecycle, purgeMemory } from "../lifecycle.js";

type PurgeArgs = { id: string; reason: string; yes: boolean; redact: boolean };

function parsePurgeArgs(args: string[]): PurgeArgs {
	let id: string | undefined;
	let reason: string | undefined;
	let yes = false;
	let redact = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--reason" && args[i + 1]) { reason = args[++i]; continue; }
		if (a === "--yes") { yes = true; continue; }
		if (a === "--redact") { redact = true; continue; }
		if (!a.startsWith("--") && !id) { id = a; continue; }
	}
	if (!id) throw new Error("required: <id>");
	if (!reason) throw new Error("required: --reason");
	if (!yes) throw new Error("required: --yes (purge is irreversible)");
	return { id, reason, yes, redact };
}

export async function runMemoryPurge(args: string[], opts: {
	repoKey: string;
	stdout?: NodeJS.WriteStream;
} = { repoKey: "" }): Promise<number> {
	try {
		const parsed = parsePurgeArgs(args);
		const lc = await openLifecycle(opts.repoKey, { agentId: "cli-user" });
		try {
			await purgeMemory(lc, parsed.id, parsed.reason, { redact: parsed.redact });
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
