// src/lib/memory/cli/restore.ts
import { openLifecycle, restoreMemory } from "../lifecycle.js";

type RestoreArgs = { id: string };

function parseRestoreArgs(args: string[]): RestoreArgs {
	let id: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (!a.startsWith("--") && !id) { id = a; continue; }
	}
	if (!id) throw new Error("required: <id>");
	return { id };
}

export async function runMemoryRestore(args: string[], opts: {
	repoKey: string;
	stdout?: NodeJS.WriteStream;
} = { repoKey: "" }): Promise<number> {
	try {
		const parsed = parseRestoreArgs(args);
		const lc = await openLifecycle(opts.repoKey, { agentId: "cli-user" });
		try {
			await restoreMemory(lc, parsed.id);
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
