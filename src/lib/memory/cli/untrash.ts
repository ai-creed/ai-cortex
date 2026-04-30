// src/lib/memory/cli/untrash.ts
import { openLifecycle, untrashMemory } from "../lifecycle.js";

type UntrashArgs = { id: string };

function parseUntrashArgs(args: string[]): UntrashArgs {
	let id: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (!a.startsWith("--") && !id) {
			id = a;
			continue;
		}
	}
	if (!id) throw new Error("required: <id>");
	return { id };
}

export async function runMemoryUntrash(
	args: string[],
	opts: {
		repoKey: string;
		stdout?: NodeJS.WriteStream;
	} = { repoKey: "" },
): Promise<number> {
	try {
		const parsed = parseUntrashArgs(args);
		const lc = await openLifecycle(opts.repoKey, { agentId: "cli-user" });
		try {
			await untrashMemory(lc, parsed.id);
			(opts.stdout ?? process.stdout).write("ok\n");
			return 0;
		} finally {
			lc.close();
		}
	} catch (err) {
		process.stderr.write(
			(err instanceof Error ? err.message : String(err)) + "\n",
		);
		return 1;
	}
}
