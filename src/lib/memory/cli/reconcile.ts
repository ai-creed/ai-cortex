// src/lib/memory/cli/reconcile.ts
import { reconcileStore } from "../reconcile.js";

type ReconcileArgs = { report: boolean };

function parseReconcileArgs(args: string[]): ReconcileArgs {
	let report = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--report") {
			report = true;
			continue;
		}
	}
	return { report };
}

export async function runMemoryReconcile(
	args: string[],
	opts: {
		repoKey: string;
		stdout?: NodeJS.WriteStream;
	} = { repoKey: "" },
): Promise<number> {
	try {
		const parsed = parseReconcileArgs(args);
		const result = await reconcileStore(opts.repoKey, "cli-reconcile");
		const out = opts.stdout ?? process.stdout;
		if (parsed.report) {
			out.write(JSON.stringify(result, null, 2) + "\n");
		} else {
			out.write("reconcile ok\n");
		}
		return 0;
	} catch (err) {
		process.stderr.write(
			(err instanceof Error ? err.message : String(err)) + "\n",
		);
		return 1;
	}
}
