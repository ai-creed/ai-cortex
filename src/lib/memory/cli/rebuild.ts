// src/lib/memory/cli/rebuild.ts
import { reconcileStore } from "../reconcile.js";

export async function runMemoryRebuildIndex(args: string[], opts: {
	repoKey: string;
	stdout?: NodeJS.WriteStream;
} = { repoKey: "" }): Promise<number> {
	try {
		const report = await reconcileStore(opts.repoKey, "cli-rebuild");
		(opts.stdout ?? process.stdout).write(JSON.stringify(report, null, 2) + "\n");
		return 0;
	} catch (err) {
		process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
		return 1;
	}
}
