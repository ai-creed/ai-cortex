// src/cli.ts
import os from "node:os";
import { getCachedIndex, indexRepo, rehydrateRepo } from "./lib/index.js";
import { IndexError, RepoIdentityError } from "./lib/models.js";

const [, , command = "index", ...args] = process.argv;

function parseArgs(flags: string[]): { repoPath: string; options: string[] } {
	const options = args.filter((arg) => flags.includes(arg));
	const repoPath = args.find((arg) => !arg.startsWith("--")) ?? process.cwd();
	return { repoPath, options };
}

try {
	if (command === "index") {
		const { repoPath, options } = parseArgs(["--refresh"]);
		const refresh = options.includes("--refresh");
		const start = performance.now();

		const existing = refresh ? null : getCachedIndex(repoPath);
		const cache = existing ?? indexRepo(repoPath);
		const duration = Math.round(performance.now() - start);

		process.stdout.write(
			`indexed ${cache.packageMeta.name}\n` +
				`  files: ${cache.files.length}  docs: ${cache.docs.length}  imports: ${cache.imports.length}  entry files: ${cache.entryFiles.length}\n` +
				`  cache: ~/.cache/ai-cortex/v1/${cache.repoKey}/${cache.worktreeKey}.json\n` +
				`  duration: ${duration}ms\n`,
		);
	} else if (command === "rehydrate") {
		const { repoPath, options } = parseArgs(["--stale", "--json"]);
		const stale = options.includes("--stale");
		const json = options.includes("--json");

		const result = rehydrateRepo(repoPath, { stale });

		if (json) {
			process.stdout.write(
				JSON.stringify(
					{
						briefingPath: result.briefingPath,
						cacheStatus: result.cacheStatus,
						packageName: result.cache.packageMeta.name,
						fileCount: result.cache.files.length,
						docCount: result.cache.docs.length,
					},
					null,
					2,
				) + "\n",
			);
		} else {
			const home = os.homedir();
			const displayPath = result.briefingPath.startsWith(home)
				? "~" + result.briefingPath.slice(home.length)
				: result.briefingPath;
			process.stdout.write(
				`rehydrated ${result.cache.packageMeta.name} (${result.cacheStatus}, ${result.cache.files.length} files, ${result.cache.docs.length} docs)\n` +
					`  briefing: ${displayPath}\n`,
			);
		}
	} else {
		process.stderr.write(`ai-cortex: unknown command: ${command}\n`);
		process.exit(1);
	}
} catch (err) {
	if (err instanceof RepoIdentityError) {
		process.stderr.write(`ai-cortex: ${err.message}\n`);
		process.exit(1);
	}
	if (err instanceof IndexError) {
		process.stderr.write(`ai-cortex: index failed: ${err.message}\n`);
		process.exit(2);
	}
	throw err;
}
