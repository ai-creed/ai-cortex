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
import type { FastSuggestResult, DeepSuggestResult, SemanticSuggestResult } from "./lib/suggest.js";
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
					process.stderr.write(`ai-cortex: --limit must be a number (got '${raw}')\n`);
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
					process.stderr.write(`ai-cortex: --pool must be a number (got '${raw}')\n`);
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
	lines.push(`mode: fast · cacheStatus: ${r.cacheStatus} · durationMs: ${r.durationMs}`);
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
		lines.push("warning: stale:true — ranking uses cached graph, snippets use current disk");
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
		lines.push(`${i + 1}. ${item.path}  [${item.kind} · score ${item.score.toFixed(3)}]`);
		lines.push(`   reason: ${item.reason}`);
	}
	return lines.join("\n").trimEnd();
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
		process.stderr.write(`history: not in a git repo (${msg}). Use --repo-key to override.\n`);
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
		if (command === "mcp") {
			const { startMcpServer } = await import("./mcp/server.js");
			await startMcpServer();
		} else if (command === "index") {
			const { repoPath, options } = parseIndexOrRehydrateArgs(args, ["--refresh"]);
			const refresh = options.includes("--refresh");
			const start = performance.now();

			const existing = refresh ? null : getCachedIndex(repoPath);
			const cache = existing ?? await indexRepo(repoPath);
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
							process.stderr.write(`ai-cortex: --limit must be a number (got '${raw}')\n`);
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
					const { getHistoryDisabledFlagPath } = await import("./lib/history/config.js");
					const p = getHistoryDisabledFlagPath();
					fs.mkdirSync(path.dirname(p), { recursive: true });
					fs.writeFileSync(p, "");
					process.stdout.write("history capture disabled\n");
					break;
				}
				case "on": {
					const { getHistoryDisabledFlagPath } = await import("./lib/history/config.js");
					const p = getHistoryDisabledFlagPath();
					if (fs.existsSync(p)) fs.unlinkSync(p);
					process.stdout.write("history capture enabled\n");
					break;
				}
				case "capture": {
					const { captureSession } = await import("./lib/history/capture.js");
					const { resolveTranscriptPath } = await import("./lib/history/session-detect.js");
					const sessionId = flagValue(rest, "--session");
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const transcript = flagValue(rest, "--transcript") ?? (sessionId ? resolveTranscriptPath(cwd, sessionId) : null);
					const repoKey = flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					if (!sessionId || !transcript) {
						process.stderr.write("usage: history capture --session <id> [--transcript <path>] [--cwd <dir>] [--repo-key <key>]\n");
						process.exit(1);
					}
					if (!fs.existsSync(transcript)) {
						process.stderr.write(`history: transcript not found: ${transcript}\n`);
						process.exit(1);
					}
					const result = await captureSession({ repoKey, sessionId, transcriptPath: transcript, embed: true });
					process.stdout.write(JSON.stringify(result) + "\n");
					break;
				}
				case "list": {
					const { listSessions, readSession } = await import("./lib/history/store.js");
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey = flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					for (const id of listSessions(repoKey)) {
						const rec = readSession(repoKey, id);
						process.stdout.write(`${id}\t${rec?.startedAt ?? ""}\thasRaw=${rec?.hasRaw ?? "?"}\n`);
					}
					break;
				}
				case "prune": {
					const { listSessions, readSession, pruneSession } = await import("./lib/history/store.js");
					const before = flagValue(rest, "--before");
					const cwd = flagValue(rest, "--cwd") ?? process.cwd();
					const repoKey = flagValue(rest, "--repo-key") ?? (await resolveRepoKeyOrExit(cwd));
					if (!before) {
						process.stderr.write("usage: history prune --before YYYY-MM-DD [--cwd <dir>] [--repo-key <key>]\n");
						process.exit(1);
					}
					const cutoff = new Date(before).getTime();
					let removed = 0;
					for (const id of listSessions(repoKey)) {
						const rec = readSession(repoKey, id);
						if (rec && new Date(rec.startedAt).getTime() < cutoff) {
							pruneSession(repoKey, id);
							removed += 1;
						}
					}
					process.stdout.write(`pruned ${removed} sessions\n`);
					break;
				}
				case "install-hooks": {
					const { installHooks } = await import("./lib/history/hooks-install.js");
					const yes = rest.includes("--yes") || rest.includes("-y");
					await installHooks({ yes });
					process.stdout.write("hooks installed\n");
					break;
				}
				case "uninstall-hooks": {
					const { uninstallHooks } = await import("./lib/history/hooks-install.js");
					const yes = rest.includes("--yes") || rest.includes("-y");
					await uninstallHooks({ yes });
					process.stdout.write("hooks uninstalled\n");
					break;
				}
				default: {
					process.stderr.write("usage: ai-cortex history <off|on|capture|list|prune|install-hooks|uninstall-hooks>\n");
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
