// src/lib/memory/cli/confirm.ts
import { openLifecycle, confirmMemory } from "../lifecycle.js";

type ConfirmArgs = { id: string };

function parseConfirmArgs(args: string[]): ConfirmArgs {
	let id: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (!a.startsWith("--") && !id) { id = a; continue; }
	}
	if (!id) throw new Error("required: <id>");
	return { id };
}

export async function runMemoryConfirm(args: string[], opts: {
	repoKey: string;
	stdout?: NodeJS.WriteStream;
} = { repoKey: "" }): Promise<number> {
	try {
		const parsed = parseConfirmArgs(args);
		const lc = await openLifecycle(opts.repoKey, { agentId: "cli-user" });
		try {
			await confirmMemory(lc, parsed.id);
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
