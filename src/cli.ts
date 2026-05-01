#!/usr/bin/env node
// src/cli.ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
	getCachedIndex,
	indexRepo,
	rehydrateRepo,
	suggestRepo,
} from "./lib/index.js";
import type {
	FastSuggestResult,
	DeepSuggestResult,
	SemanticSuggestResult,
} from "./lib/suggest.js";
import { IndexError, RepoIdentityError } from "./lib/models.js";

const [, , command = "index", ...args] = process.argv;

function readPackageVersion(): string {
	const pkgPath = new URL("../../package.json", import.meta.url);
	const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
		version: string;
	};
	return pkg.version;
}

const HELP_TEXT = `ai-cortex <command> [options]

Commands:
  index [path] [--refresh]         Index a repository (default command)
  rehydrate [path] [--stale]       Refresh and load cached index
  suggest <task> [path] [options]  Suggest relevant files for a task
  mcp                              Start the MCP server (stdio)
  history <subcommand>             Manage session history capture
  memory <subcommand>              Manage the memory store
  help, --help, -h                 Show this help
  version, --version, -v           Show version

Run 'ai-cortex <command>' with no args to see subcommand usage.
`;

function parseIndexOrRehydrateArgs(
	argv: string[],
	flags: string[],
): { repoPath: string; options: string[] } {
	const options = argv.filter((arg) => flags.includes(arg));
	const repoPath = argv.find((arg) => !arg.startsWith("--")) ?? process.cwd();
	return { repoPath, options };
}

function parseSuggestArgs(
	argv: string[],
	options: { deep?: boolean } = {},
): {
	task: string;
	repoPath: string;
	from?: string;
	limit?: number;
	poolSize?: number;
	json: boolean;
	stale: boolean;
	verbose: boolean;
} {
	let task: string | null = null;
	let repoPath: string | null = null;
	let from: string | undefined;
	let limit: number | undefined;
	let poolSize: number | undefined;
	let json = false;
	let stale = false;
	let verbose = false;

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
		if (arg === "--verbose") {
			verbose = true;
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
				const raw = argv[i + 1];
				const parsed = Number(raw);
				if (!Number.isFinite(parsed)) {
					process.stderr.write(
						`ai-cortex: --limit must be a number (got '${raw}')\n`,
					);
					process.exit(1);
				}
				limit = parsed;
				i += 1;
			}
			continue;
		}
		if (options.deep && arg === "--pool") {
			if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) {
				const raw = argv[i + 1];
				const parsed = Number(raw);
				if (!Number.isFinite(parsed)) {
					process.stderr.write(
						`ai-cortex: --pool must be a number (got '${raw}')\n`,
					);
					process.exit(1);
				}
				poolSize = parsed;
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
		poolSize,
		json,
		stale,
		verbose,
	};
}

function renderFastCli(r: FastSuggestResult): string {
	const lines: string[] = [];
	lines.push(`suggested files for: ${r.task}`);
	lines.push(
		`mode: fast · cacheStatus: ${r.cacheStatus} · durationMs: ${r.durationMs}`,
	);
	lines.push("");
	for (const [i, item] of r.results.entries()) {
		lines.push(`${i + 1}. ${item.path}  [${item.kind} · score ${item.score}]`);
		lines.push(`   reason: ${item.reason}`);
	}
	lines.push("");
	lines.push(escalationHint(r));
	return lines.join("\n").trimEnd();
}

function renderDeepCli(r: DeepSuggestResult): string {
	const lines: string[] = [];
	lines.push(`suggested files (deep) for: ${r.task}`);
	lines.push(
		`mode: deep · cacheStatus: ${r.cacheStatus} · durationMs: ${r.durationMs} · pool: ${r.poolSize}`,
	);
	if (r.staleMixedEvidence) {
		lines.push(
			"warning: stale:true — ranking uses cached graph, snippets use current disk",
		);
	}
	lines.push("");
	for (const [i, item] of r.results.entries()) {
		lines.push(`${i + 1}. ${item.path}  [${item.kind} · score ${item.score}]`);
		lines.push(`   reason: ${item.reason}`);
		if (item.contentHits && item.contentHits.length > 0) {
			lines.push("   content:");
			for (const h of item.contentHits) {
				lines.push(`     L${h.line}: ${h.snippet}`);
			}
		}
	}
	return lines.join("\n").trimEnd();
}

export function renderSemanticText(r: SemanticSuggestResult): string {
	const lines: string[] = [];
	lines.push(`suggested files (semantic) for: ${r.task}`);
	lines.push(
		`mode: semantic · cacheStatus: ${r.cacheStatus} · durationMs: ${r.durationMs} · pool: ${r.poolSize}`,
	);
	lines.push("");
	for (const [i, item] of r.results.entries()) {
		lines.push(
			`${i + 1}. ${item.path}  [${item.kind} · score ${item.score.toFixed(3)}]`,
		);
		lines.push(`   reason: ${item.reason}`);
	}
	return lines.join("\n").trimEnd();
}

function stripFlagPairs(args: string[], flags: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (flags.includes(args[i]) && i + 1 < args.length) {
			i++;
			continue;
		}
		out.push(args[i]);
	}
	return out;
}

async function cliMemoryRecall(args: string[]): Promise<void> {
	let query = "";
	let json = false;
	let limit = 10;
	let cwd = process.cwd();
	let repoKey: string | null = null;
	const scopeFiles: string[] = [];
	const tags: string[] = [];
	let type: string | undefined;
	let source: "project" | "global" | "all" = "all";

	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--json") {
			json = true;
			continue;
		}
		if (a === "--limit" && args[i + 1]) {
			limit = Number(args[++i]);
			continue;
		}
		if (a === "--cwd" && args[i + 1]) {
			cwd = args[++i];
			continue;
		}
		if (a === "--repo-key" && args[i + 1]) {
			repoKey = args[++i];
			continue;
		}
		if (a === "--scope-file" && args[i + 1]) {
			scopeFiles.push(args[++i]);
			continue;
		}
		if (a === "--tag" && args[i + 1]) {
			tags.push(args[++i]);
			continue;
		}
		if (a === "--type" && args[i + 1]) {
			type = args[++i];
			continue;
		}
		if (a === "--source" && args[i + 1]) {
			const val = args[++i];
			if (val !== "project" && val !== "global" && val !== "all") {
				process.stderr.write(
					`ai-cortex: --source must be project, global, or all (got '${val}')\n`,
				);
				process.exit(1);
			}
			source = val;
			continue;
		}
		if (!a.startsWith("--") && !query) {
			query = a;
			continue;
		}
	}
	const rk = repoKey ?? (await resolveRepoKeyOrExit(cwd));
	const { openRetrieve, recallMemory, recallMemoryCrossTier } =
		await import("./lib/memory/retrieve.js");

	const recallOpts = {
		limit,
		scope:
			scopeFiles.length || tags.length
				? { files: scopeFiles, tags }
				: undefined,
		type: type ? [type] : undefined,
	};

	let results;

	if (source === "global") {
		const rh = openRetrieve("global");
		try {
			results = await recallMemory(rh, query, recallOpts);
		} finally {
			rh.close();
		}
	} else if (source === "all") {
		const projectRh = openRetrieve(rk);
		const globalRh = openRetrieve("global");
		try {
			results = await recallMemoryCrossTier(projectRh, globalRh, query, recallOpts);
		} finally {
			projectRh.close();
			globalRh.close();
		}
	} else {
		const rh = openRetrieve(rk);
		try {
			results = await recallMemory(rh, query, recallOpts);
		} finally {
			rh.close();
		}
	}

	if (json) {
		process.stdout.write(JSON.stringify(results, null, 2) + "\n");
	} else {
		if (results.length === 0) {
			process.stdout.write("no results\n");
			return;
		}
		for (const r of results) {
			process.stdout.write(
				`${r.id}  [${r.type}/${r.status}] score=${r.score.toFixed(3)}  ${r.title}\n`,
			);
			process.stdout.write(`  ${r.bodyExcerpt}\n`);
		}
	}
}

async function cliMemorySearch(args: string[]): Promise<void> {
	let query = "";
	let json = false;
	let limit = 10;
	let cwd = process.cwd();
	let repoKey: string | null = null;

	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--json") {
			json = true;
			continue;
		}
		if (a === "--limit" && args[i + 1]) {
			limit = Number(args[++i]);
			continue;
		}
		if (a === "--cwd" && args[i + 1]) {
			cwd = args[++i];
			continue;
		}
		if (a === "--repo-key" && args[i + 1]) {
			repoKey = args[++i];
			continue;
		}
		if (!a.startsWith("--") && !query) {
			query = a;
			continue;
		}
	}
	const rk = repoKey ?? (await resolveRepoKeyOrExit(cwd));
	const { openRetrieve, searchMemories } =
		await import("./lib/memory/retrieve.js");
	const rh = openRetrieve(rk);
	try {
		const results = searchMemories(rh, query, limit);
		if (json) {
			process.stdout.write(JSON.stringify(results, null, 2) + "\n");
		} else {
			if (results.length === 0) {
				process.stdout.write("no results\n");
				return;
			}
			for (const r of results) {
				process.stdout.write(
					`${r.id}  [${r.type}] rank=${r.rank}  ${r.title}\n`,
				);
			}
		}
	} finally {
		rh.close();
	}
}

function flagValue(argv: string[], name: string): string | undefined {
	const idx = argv.indexOf(name);
	if (idx === -1 || idx === argv.length - 1) return undefined;
	return argv[idx + 1];
}

async function resolveRepoKeyOrExit(cwd: string): Promise<string> {
	try {
		const { resolveRepoIdentity } = await import("./lib/repo-identity.js");
		return resolveRepoIdentity(cwd).repoKey;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(
			`history: not in a git repo (${msg}). Use --repo-key to override.\n`,
		);
		process.exit(1);
	}
}

function escalationHint(r: FastSuggestResult): string {
	const topScore = r.results[0]?.score ?? 0;
	const fileCount = r.results.filter((x) => x.kind === "file").length;
	const reasons: string[] = [];
	if (topScore < 10) reasons.push(`top score=${topScore} is low`);
	if (fileCount === 0) reasons.push("no code files in top-N");
	const summary =
		reasons.length > 0
			? `consider suggest_files_deep (${reasons.join("; ")})`
			: "deep unlikely to help";
	return `escalation hint: top score=${topScore}, ${fileCount} code files in top-${r.results.length} — ${summary}`;
}

async function main(): Promise<void> {
	try {
		const {
			INTERNAL_UPDATE_CHECK_FLAG,
			checkForUpdate,
			runBackgroundFetch,
			printUpdateNotice,
		} = await import("./lib/update-notifier.js");

		if (command === INTERNAL_UPDATE_CHECK_FLAG) {
			await runBackgroundFetch();
			process.exit(0);
		}

		const currentVersion = readPackageVersion();
		const updateAvailable = checkForUpdate({ currentVersion, command });
		if (updateAvailable) {
			process.on("exit", () => {
				printUpdateNotice(currentVersion, updateAvailable);
			});
		}

		if (command === "--version" || command === "-v" || command === "version") {
			process.stdout.write(`ai-cortex ${currentVersion}\n`);
			process.exit(0);
		}
		if (command === "--help" || command === "-h" || command === "help") {
			process.stdout.write(HELP_TEXT);
			process.exit(0);
		}
		if (command === "mcp") {
			const { startMcpServer } = await import("./mcp/server.js");
			await startMcpServer();
		} else if (command === "index") {
			const { repoPath, options } = parseIndexOrRehydrateArgs(args, [
				"--refresh",
			]);
			const refresh = options.includes("--refresh");
			const start = performance.now();

			const existing = refresh ? null : await getCachedIndex(repoPath);
			const cache = existing ?? (await indexRepo(repoPath));
			const duration = Math.round(performance.now() - start);

			process.stdout.write(
				`indexed ${cache.packageMeta.name}\n` +
					`  files: ${cache.files.length}  docs: ${cache.docs.length}  imports: ${cache.imports.length}  entry files: ${cache.entryFiles.length}\n` +
					`  cache: ~/.cache/ai-cortex/v1/${cache.repoKey}/${cache.worktreeKey}.json\n` +
					`  duration: ${duration}ms\n`,
			);
		} else if (command === "rehydrate") {
			const { repoPath, options } = parseIndexOrRehydrateArgs(args, [
				"--stale",
				"--json",
			]);
			const stale = options.includes("--stale");
			const json = options.includes("--json");

			const result = await rehydrateRepo(repoPath, { stale });

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
			const result = await suggestRepo(parsed.repoPath, parsed.task, {
				from: parsed.from,
				limit: parsed.limit,
				stale: parsed.stale,
				mode: "fast",
			});
			if (result.mode !== "fast") {
				throw new Error("expected fast result for 'suggest'");
			}

			if (parsed.json) {
				process.stdout.write(JSON.stringify(result, null, 2) + "\n");
			} else {
				process.stdout.write(renderFastCli(result) + "\n");
			}
		} else if (command === "suggest-deep") {
			const parsed = parseSuggestArgs(args, { deep: true });
			const result = await suggestRepo(parsed.repoPath, parsed.task, {
				from: parsed.from,
				limit: parsed.limit,
				stale: parsed.stale,
				poolSize: parsed.poolSize,
				verbose: parsed.verbose,
				mode: "deep",
			});
			if (result.mode !== "deep") {
				throw new Error("expected deep result for 'suggest-deep'");
			}

			if (parsed.json) {
				process.stdout.write(JSON.stringify(result, null, 2) + "\n");
			} else {
				process.stdout.write(renderDeepCli(result) + "\n");
			}
		} else if (command === "suggest-semantic") {
			let task: string | null = null;
			let repoPath: string | null = null;
			let limit = 10;
			let stale = false;
			let json = false;

			for (let i = 0; i < args.length; i += 1) {
				const arg = args[i];
				if (arg === "--json") {
					json = true;
					continue;
				}
				if (arg === "--stale") {
					stale = true;
					continue;
				}
				if (arg === "-p" || arg === "--path") {
					if (args[i + 1] !== undefined && !args[i + 1]!.startsWith("-")) {
						repoPath = args[i + 1]!;
						i += 1;
					}
					continue;
				}
				if (arg === "-l" || arg === "--limit") {
					if (args[i + 1] !== undefined && !args[i + 1]!.startsWith("-")) {
						const raw = args[i + 1]!;
						const parsed = Number(raw);
						if (!Number.isFinite(parsed)) {
							process.stderr.write(
								`ai-cortex: --limit must be a number (got '${raw}')\n`,
							);
							process.exit(1);
						}
						limit = parsed;
						i += 1;
					}
					continue;
				}
				if (task === null) {
					task = arg;
				}
			}

			const result = await suggestRepo(repoPath ?? process.cwd(), task ?? "", {
				limit,
				stale,
				mode: "semantic",
			});
			if (result.mode !== "semantic") {
				process.stderr.write("unexpected mode: " + result.mode + "\n");
				process.exit(1);
			}
			if (json) {
				process.stdout.write(JSON.stringify(result) + "\n");
			} else {
				process.stdout.write(renderSemanticText(result) + "\n");
			}
		} else if (command === "history") {
			const sub = args[0];
			const rest = args.slice(1);
			switch (sub) {
				case "off": {
					const { getHistoryDisabledFlagPath } =
						await import("./lib/history/config.js");
					const p = getHistoryDisabledFlagPath();
					fs.mkdirSync(path.dirname(p), { recursive: true });
					fs.writeFileSync(p, "");
					process.stdout.write("history capture disabled\n");
					break;
				}
				case "on": {
					const { getHistoryDisabledFlagPath } =
						await import("./lib/history/config.js");
					const p = getHistoryDisabledFlagPath();
					if (fs.existsSync(p)) fs.unlinkSync(p);
					process.stdout.write("history capture enabled\n");
					break;
				}
				case "capture": {
					const { captureSession } = await import("./lib/history/capture.js");
					const { isHistoryEnabled } = await import("./lib/history/config.js");
					const { resolveTranscriptPath } =
						await import("./lib/history/session-detect.js");
					let sessionId = flagValue(rest, "--session");
					let transcriptOverride = flagValue(rest, "--transcript");
					let hookMode = false;
					// Claude Code hooks pass session data via stdin JSON (not env vars)
					if (!sessionId && !process.stdin.isTTY) {
						try {
							const raw = await new Promise<string>((resolve) => {
								let buf = "";
								process.stdin.setEncoding("utf8");
								process.stdin.on("data", (chunk) => {
									buf += chunk;
								});
								process.stdin.on("end", () => resolve(buf));
							});
							const hookData = JSON.parse(raw) as {
								session_id?: string;
								transcript_path?: string;
							};
							hookMode = true;
							if (hookData.session_id) sessionId = hookData.session_id;
							if (!transcriptOverride && hookData.transcript_path)
								transcriptOverride = hookData.transcript_path;
						} catch {
							// not a JSON hook payload; fall through to usage error
						}
					}
					if (!isHistoryEnabled()) {
						process.stdout.write(
							JSON.stringify(
								hookMode ? { continue: true } : { status: "disabled" },
							) + "\n",
						);
						break;
					}
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const transcript =
						transcriptOverride ??
						(sessionId ? resolveTranscriptPath(cwd, sessionId) : null);
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					if (!sessionId || !transcript) {
						process.stderr.write(
							"usage: history capture --session <id> [--transcript <path>] [--cwd <dir>] [--repo-key <key>]\n",
						);
						process.exit(1);
					}
					if (!fs.existsSync(transcript)) {
						process.stderr.write(
							`history: transcript not found: ${transcript}\n`,
						);
						process.exit(1);
					}
					const result = await captureSession({
						repoKey,
						sessionId,
						transcriptPath: transcript,
						embed: true,
					});
					process.stdout.write(
						JSON.stringify(hookMode ? { continue: true } : result) + "\n",
					);
					break;
				}
				case "list": {
					const { listSessions, readSession } =
						await import("./lib/history/store.js");
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					for (const id of await listSessions(repoKey)) {
						const rec = await readSession(repoKey, id);
						process.stdout.write(
							`${id}\t${rec?.startedAt ?? ""}\thasRaw=${rec?.hasRaw ?? "?"}\n`,
						);
					}
					break;
				}
				case "prune": {
					const { listSessions, readSession, pruneSession } =
						await import("./lib/history/store.js");
					const before = flagValue(rest, "--before");
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					if (!before) {
						process.stderr.write(
							"usage: history prune --before YYYY-MM-DD [--cwd <dir>] [--repo-key <key>]\n",
						);
						process.exit(1);
					}
					const cutoff = new Date(before).getTime();
					let removed = 0;
					for (const id of await listSessions(repoKey)) {
						const rec = await readSession(repoKey, id);
						if (rec && new Date(rec.startedAt).getTime() < cutoff) {
							await pruneSession(repoKey, id);
							removed += 1;
						}
					}
					process.stdout.write(`pruned ${removed} sessions\n`);
					break;
				}
				case "install-hooks": {
					const { installHooks } =
						await import("./lib/history/hooks-install.js");
					const yes = rest.includes("--yes") || rest.includes("-y");
					const installResult = await installHooks({ yes });
					if (installResult === "installed")
						process.stdout.write("hooks installed\n");
					break;
				}
				case "uninstall-hooks": {
					const { uninstallHooks } =
						await import("./lib/history/hooks-install.js");
					const yes = rest.includes("--yes") || rest.includes("-y");
					const uninstallResult = await uninstallHooks({ yes });
					if (uninstallResult === "uninstalled")
						process.stdout.write("hooks uninstalled\n");
					break;
				}
				default: {
					process.stderr.write(
						"usage: ai-cortex history <off|on|capture|list|prune|install-hooks|uninstall-hooks>\n",
					);
					process.exit(1);
				}
			}
			process.exit(0);
		} else if (command === "memory") {
			const sub = args[0];
			const rest = args.slice(1);
			switch (sub) {
				case "bootstrap": {
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					const { runMemoryBootstrap } =
						await import("./lib/memory/cli/bootstrap.js");
					const code = await runMemoryBootstrap(
						stripFlagPairs(rest, ["--cwd", "--repo-key"]),
						{ repoKey },
					);
					if (code !== 0) process.exit(code);
					break;
				}
				case "recall": {
					await cliMemoryRecall(rest);
					break;
				}
				case "search": {
					await cliMemorySearch(rest);
					break;
				}
				case "record": {
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					const { runMemoryRecord } =
						await import("./lib/memory/cli/record.js");
					const subArgs = stripFlagPairs(rest, ["--cwd", "--repo-key"]);
					const code = await runMemoryRecord(subArgs, { repoKey });
					if (code !== 0) process.exit(code);
					break;
				}
				case "extract": {
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					const { runMemoryExtract } =
						await import("./lib/memory/cli/extract.js");
					const code = await runMemoryExtract(
						stripFlagPairs(rest, ["--cwd", "--repo-key"]),
						{ repoKey },
					);
					if (code !== 0) process.exit(code);
					break;
				}
				case "extractor-log": {
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					const { runMemoryExtractorLog } =
						await import("./lib/memory/cli/extractor-log.js");
					const code = await runMemoryExtractorLog(
						stripFlagPairs(rest, ["--cwd", "--repo-key"]),
						{ repoKey },
					);
					if (code !== 0) process.exit(code);
					break;
				}
				case "get": {
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					const { runMemoryGet } = await import("./lib/memory/cli/get.js");
					const code = await runMemoryGet(
						stripFlagPairs(rest, ["--cwd", "--repo-key"]),
						{ repoKey },
					);
					if (code !== 0) process.exit(code);
					break;
				}
				case "list": {
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					const { runMemoryList } = await import("./lib/memory/cli/list.js");
					const code = await runMemoryList(
						stripFlagPairs(rest, ["--cwd", "--repo-key"]),
						{ repoKey },
					);
					if (code !== 0) process.exit(code);
					break;
				}
				case "update": {
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					const { runMemoryUpdate } =
						await import("./lib/memory/cli/update.js");
					const code = await runMemoryUpdate(
						stripFlagPairs(rest, ["--cwd", "--repo-key"]),
						{ repoKey },
					);
					if (code !== 0) process.exit(code);
					break;
				}
				case "deprecate": {
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					const { runMemoryDeprecate } =
						await import("./lib/memory/cli/deprecate.js");
					const code = await runMemoryDeprecate(
						stripFlagPairs(rest, ["--cwd", "--repo-key"]),
						{ repoKey },
					);
					if (code !== 0) process.exit(code);
					break;
				}
				case "restore": {
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					const { runMemoryRestore } =
						await import("./lib/memory/cli/restore.js");
					const code = await runMemoryRestore(
						stripFlagPairs(rest, ["--cwd", "--repo-key"]),
						{ repoKey },
					);
					if (code !== 0) process.exit(code);
					break;
				}
				case "merge": {
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					const { runMemoryMerge } = await import("./lib/memory/cli/merge.js");
					const code = await runMemoryMerge(
						stripFlagPairs(rest, ["--cwd", "--repo-key"]),
						{ repoKey },
					);
					if (code !== 0) process.exit(code);
					break;
				}
				case "trash": {
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					const { runMemoryTrash } = await import("./lib/memory/cli/trash.js");
					const code = await runMemoryTrash(
						stripFlagPairs(rest, ["--cwd", "--repo-key"]),
						{ repoKey },
					);
					if (code !== 0) process.exit(code);
					break;
				}
				case "untrash": {
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					const { runMemoryUntrash } =
						await import("./lib/memory/cli/untrash.js");
					const code = await runMemoryUntrash(
						stripFlagPairs(rest, ["--cwd", "--repo-key"]),
						{ repoKey },
					);
					if (code !== 0) process.exit(code);
					break;
				}
				case "purge": {
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					const { runMemoryPurge } = await import("./lib/memory/cli/purge.js");
					const code = await runMemoryPurge(
						stripFlagPairs(rest, ["--cwd", "--repo-key"]),
						{ repoKey },
					);
					if (code !== 0) process.exit(code);
					break;
				}
				case "link": {
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					const { runMemoryLink } = await import("./lib/memory/cli/link.js");
					const code = await runMemoryLink(
						stripFlagPairs(rest, ["--cwd", "--repo-key"]),
						{ repoKey },
					);
					if (code !== 0) process.exit(code);
					break;
				}
				case "unlink": {
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					const { runMemoryUnlink } =
						await import("./lib/memory/cli/unlink.js");
					const code = await runMemoryUnlink(
						stripFlagPairs(rest, ["--cwd", "--repo-key"]),
						{ repoKey },
					);
					if (code !== 0) process.exit(code);
					break;
				}
				case "pin": {
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					const { runMemoryPin } = await import("./lib/memory/cli/pin.js");
					const code = await runMemoryPin(
						stripFlagPairs(rest, ["--cwd", "--repo-key"]),
						{ repoKey },
					);
					if (code !== 0) process.exit(code);
					break;
				}
				case "unpin": {
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					const { runMemoryUnpin } = await import("./lib/memory/cli/pin.js");
					const code = await runMemoryUnpin(
						stripFlagPairs(rest, ["--cwd", "--repo-key"]),
						{ repoKey },
					);
					if (code !== 0) process.exit(code);
					break;
				}
				case "confirm": {
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					const { runMemoryConfirm } =
						await import("./lib/memory/cli/confirm.js");
					const code = await runMemoryConfirm(
						stripFlagPairs(rest, ["--cwd", "--repo-key"]),
						{ repoKey },
					);
					if (code !== 0) process.exit(code);
					break;
				}
				case "audit": {
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					const { runMemoryAudit } = await import("./lib/memory/cli/audit.js");
					const code = await runMemoryAudit(
						stripFlagPairs(rest, ["--cwd", "--repo-key"]),
						{ repoKey },
					);
					if (code !== 0) process.exit(code);
					break;
				}
				case "rebuild-index": {
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					const { runMemoryRebuildIndex } =
						await import("./lib/memory/cli/rebuild.js");
					const code = await runMemoryRebuildIndex(
						stripFlagPairs(rest, ["--cwd", "--repo-key"]),
						{ repoKey },
					);
					if (code !== 0) process.exit(code);
					break;
				}
				case "reconcile": {
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					const { runMemoryReconcile } =
						await import("./lib/memory/cli/reconcile.js");
					const code = await runMemoryReconcile(
						stripFlagPairs(rest, ["--cwd", "--repo-key"]),
						{ repoKey },
					);
					if (code !== 0) process.exit(code);
					break;
				}
				case "sweep": {
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					const { runMemorySweep } = await import("./lib/memory/cli/sweep.js");
					const code = await runMemorySweep(
						stripFlagPairs(rest, ["--cwd", "--repo-key"]),
						{ repoKey },
					);
					if (code !== 0) process.exit(code);
					break;
				}
				case "promote": {
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey =
						flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					const { runMemoryPromote } =
						await import("./lib/memory/cli/promote.js");
					const code = await runMemoryPromote(
						stripFlagPairs(rest, ["--cwd", "--repo-key"]),
						{ repoKey },
					);
					if (code !== 0) process.exit(code);
					break;
				}
				default: {
					process.stderr.write(
						"usage: ai-cortex memory <bootstrap|recall|search|record|get|list|update|deprecate|restore|merge|trash|untrash|purge|link|unlink|pin|unpin|confirm|audit|rebuild-index|reconcile|extract|extractor-log|sweep|promote>\n",
					);
					process.exit(1);
				}
			}
			process.exit(0);
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
