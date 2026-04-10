// src/cli.ts
import { getCachedIndex, indexRepo } from "./lib/index.js";
import { IndexError, RepoIdentityError } from "./lib/models.js";

const [, , command = "index", ...args] = process.argv;

if (command === "index") {
	const refresh = args.includes("--refresh");
	const repoPath = args.find(arg => arg !== "--refresh") ?? process.cwd();
	const start = performance.now();

	try {
		const existing = refresh ? null : getCachedIndex(repoPath);
		const cache = existing ?? indexRepo(repoPath);
		const duration = Math.round(performance.now() - start);

		process.stdout.write(
			`indexed ${cache.packageMeta.name}\n` +
			`  files: ${cache.files.length}  docs: ${cache.docs.length}  imports: ${cache.imports.length}  entry files: ${cache.entryFiles.length}\n` +
			`  cache: ~/.cache/ai-cortex/v1/${cache.repoKey}/${cache.worktreeKey}.json\n` +
			`  duration: ${duration}ms\n`
		);
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
} else {
	process.stderr.write(`ai-cortex: unknown command: ${command}\n`);
	process.exit(1);
}
