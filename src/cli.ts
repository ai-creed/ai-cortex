// src/cli.ts
import os from "node:os";
import {
	getCachedIndex,
	indexRepo,
	rehydrateRepo,
	suggestRepo,
} from "./lib/index.js";
import { IndexError, RepoIdentityError } from "./lib/models.js";

const [, , command = "index", ...args] = process.argv;

function parseIndexOrRehydrateArgs(
	argv: string[],
	flags: string[],
): { repoPath: string; options: string[] } {
	const options = argv.filter((arg) => flags.includes(arg));
	const repoPath = argv.find((arg) => !arg.startsWith("--")) ?? process.cwd();
	return { repoPath, options };
}

function parseSuggestArgs(argv: string[]): {
	task: string;
	repoPath: string;
	from?: string;
	limit?: number;
	json: boolean;
	stale: boolean;
} {
	let task: string | null = null;
	let repoPath: string | null = null;
	let from: string | undefined;
	let limit: number | undefined;
	let json = false;
	let stale = false;

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--stale") {
			stale = true;
			continue;
		}
		if (arg === "--from") {
			if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) {
				from = argv[i + 1];
				i += 1;
			}
			continue;
		}
		if (arg === "--limit") {
			if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) {
				limit = Number(argv[i + 1]);
				i += 1;
			}
			continue;
		}
		if (task === null) {
			task = arg;
			continue;
		}
		if (repoPath === null) {
			repoPath = arg;
		}
	}

	return {
		task: task ?? "",
		repoPath: repoPath ?? process.cwd(),
		from,
		limit,
		json,
		stale,
	};
}

async function main(): Promise<void> {
	try {
		if (command === "mcp") {
			const { startMcpServer } = await import("./mcp/server.js");
			await startMcpServer();
		} else if (command === "index") {
			const { repoPath, options } = parseIndexOrRehydrateArgs(args, ["--refresh"]);
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
			const { repoPath, options } = parseIndexOrRehydrateArgs(args, ["--stale", "--json"]);
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
		} else if (command === "suggest") {
			const parsed = parseSuggestArgs(args);
			const result = suggestRepo(parsed.repoPath, parsed.task, {
				from: parsed.from,
				limit: parsed.limit,
				stale: parsed.stale,
			});

			if (parsed.json) {
				process.stdout.write(JSON.stringify(result, null, 2) + "\n");
			} else {
				process.stdout.write(`suggested files for: ${result.task}\n\n`);
				for (const [index, item] of result.results.entries()) {
					process.stdout.write(
						`${index + 1}. ${item.path}\n   reason: ${item.reason}\n\n`,
					);
				}
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
}

main();
