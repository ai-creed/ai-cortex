// src/mcp/server.ts
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { indexRepo, rehydrateRepo, suggestRepo } from "../lib/index.js";
import type {
	DeepSuggestResult,
	SemanticSuggestResult,
} from "../lib/suggest.js";
import {
	DeepSuggestResultSchema,
	SemanticSuggestResultSchema,
} from "../lib/suggest.js";
import { searchHistory } from "../lib/history/search.js";
import { captureSession } from "../lib/history/capture.js";
import { isHistoryEnabled } from "../lib/history/config.js";
import {
	detectCurrentSession,
	resolveTranscriptPath,
} from "../lib/history/session-detect.js";
import { resolveRepoIdentity, validateWorktreePath } from "../lib/repo-identity.js";
import { ensureFreshDb } from "../lib/cache-coordinator.js";
import { queryBlastRadiusDb } from "../lib/blast-radius.js";
import { runRepoKeyMigrationIfNeeded } from "../lib/cache-store-migrate.js";
import { getProvider, MODEL_NAME } from "../lib/embed-provider.js";
import { VERSION as SERVER_VERSION } from "../version.js";
import { getBriefingNotice } from "../lib/update-notifier.js";
import { getHookMigrationNotice } from "../lib/migration-notifier.js";
import {
	openRetrieve,
	getMemory,
	listMemories,
	listMemoriesPendingRewrite,
	auditMemory,
	searchMemories,
	recallMemory,
	recallMemoryCrossTier,
} from "../lib/memory/retrieve.js";
import {
	openLifecycle,
	openGlobalLifecycle,
	GLOBAL_REPO_KEY,
	createMemory,
	promoteToGlobal,
	updateMemory,
	updateScope,
	deprecateMemory,
	restoreMemory,
	mergeMemories,
	trashMemory,
	untrashMemory,
	purgeMemory,
	linkMemories,
	unlinkMemories,
	pinMemory,
	unpinMemory,
	confirmMemory,
	addEvidence,
	rewriteMemory,
} from "../lib/memory/lifecycle.js";
import {
	typeContractHint,
	applyTypeFieldDefaults,
} from "../lib/memory/registry.js";
import { reconcileStore } from "../lib/memory/reconcile.js";
import { matchMemoriesCrossTier, type SuggestMode } from "../lib/memory/surface.js";
import type { StatsParamFields, StatsResultFields } from "../lib/stats/types.js";
import { getSink } from "../lib/stats/registry.js";
import { writeEvent } from "../lib/stats/sink.js";
import { errClassOf, errMessageOf, errCodeOf } from "../lib/stats/sanitize.js";
import { appendGetEvent } from "../lib/stats/surface-events.js";
import {
	registerSource as libRegisterSource,
	listSources as libListSources,
	listSourceStatuses as libListSourceStatuses,
	reindexLibrary,
	searchLibrary,
	LibrarySearchInput,
	LibraryRegisterInput,
	LibraryReindexInput,
	LibrarySearchResultSchema,
} from "../lib/library/index.js";

function logCall(
	tool: string,
	meta: Record<string, unknown>,
	durMs: number,
	status: "ok" | "error",
	err?: unknown,
): void {
	const parts = [`[ai-cortex] tool=${tool}`];
	for (const [k, v] of Object.entries(meta)) {
		if (v === undefined) continue;
		const s = String(v);
		parts.push(`${k}=${s.length > 80 ? s.slice(0, 77) + "..." : s}`);
	}
	parts.push(`dur=${durMs}ms`);
	parts.push(`status=${status}`);
	if (status === "error" && err instanceof Error) {
		parts.push(`err="${err.message}"`);
	}
	process.stderr.write(parts.join(" ") + "\n");
}

type SafeWriteArgs<P, R> = {
	params: P;
	tool: string;
	ts: number;
	dur_ms: number;
	resolveRepoKey: (p: P) => string | null;
	extractStatsParams: (p: P) => StatsParamFields | null;
} & (
	| { status: "ok"; result: R; extractResult: (r: R) => StatsResultFields | null }
	| { status: "error"; err: unknown }
);

function scheduleSinkWrite<P, R>(args: SafeWriteArgs<P, R>): void {
	// Under vitest, only write to the sink when a test has explicitly opted in
	// by setting AI_CORTEX_CACHE_HOME. This prevents the suite from polluting
	// the user's real ~/.cache/ai-cortex/v1/ tree with empty stats/ dirs every
	// time an MCP-exercising test runs without its own cache override.
	if (process.env.VITEST && !process.env.AI_CORTEX_CACHE_HOME) return;

	// Snapshot the cache home at schedule time. setImmediate defers the write
	// past test boundaries — by the time the callback fires, afterEach may
	// have restored AI_CORTEX_CACHE_HOME, causing getSink to write to the
	// real cache instead of the test tmpdir. If the env doesn't match what we
	// saw at schedule time, the test boundary has passed and we drop the row.
	const cacheHomeAtSchedule = process.env.AI_CORTEX_CACHE_HOME;

	setImmediate(() => {
		if (process.env.AI_CORTEX_CACHE_HOME !== cacheHomeAtSchedule) return;
		try {
			const repoKey = args.resolveRepoKey(args.params);
			if (!repoKey) return;
			const sParams = args.extractStatsParams(args.params) ?? {};
			const sResult =
				args.status === "ok" ? (args.extractResult(args.result) ?? {}) : {};
			writeEvent(getSink(repoKey), {
				ts: args.ts,
				tool: args.tool,
				dur_ms: args.dur_ms,
				status: args.status,
				session_id: resolveLoggedSessionId(),
				...(args.status === "error"
					? {
							err_class: errClassOf(args.err),
							err_code: errCodeOf(args.err),
							err_message: errMessageOf(args.err),
						}
					: {}),
				...sParams,
				...sResult,
			});
		} catch (e) {
			process.stderr.write(
				`[ai-cortex] stats sink failed: ${e instanceof Error ? e.message : String(e)}\n`,
			);
		}
	});
}

// Best-effort session attribution for stats: env-preferred with a heuristic
// fallback (see detectCurrentSession). The MCP server serves one session for
// its lifetime, so resolve once and memoize — avoids a per-event filesystem
// scan when no canonical session env var is set. Never throws.
let memoizedSessionId: string | null | undefined;
export function resolveLoggedSessionId(): string | null {
	if (memoizedSessionId !== undefined) return memoizedSessionId;
	try {
		memoizedSessionId =
			detectCurrentSession({ cwd: process.cwd() })?.sessionId ?? null;
	} catch {
		memoizedSessionId = null;
	}
	return memoizedSessionId;
}

/** Test-only: clear the memoized session id between cases. */
export function _resetSessionIdMemoForTest(): void {
	memoizedSessionId = undefined;
}

export function logged<P, R>(
	tool: string,
	extractMeta: (params: P) => Record<string, unknown>,
	extractStatsParams: (params: P) => StatsParamFields | null,
	resolveRepoKey: (params: P) => string | null,
	extractResult: (result: R) => StatsResultFields | null,
	handler: (params: P) => Promise<R>,
): (params: P) => Promise<R> {
	return async (params: P) => {
		const t0 = performance.now();
		try {
			const result = await handler(params);
			const durMs = Math.round(performance.now() - t0);
			logCall(tool, extractMeta(params), durMs, "ok");
			scheduleSinkWrite<P, R>({
				params,
				tool,
				ts: Date.now(),
				dur_ms: durMs,
				resolveRepoKey,
				extractStatsParams,
				status: "ok",
				result,
				extractResult,
			});
			return result;
		} catch (err) {
			const durMs = Math.round(performance.now() - t0);
			logCall(tool, extractMeta(params), durMs, "error", err);
			scheduleSinkWrite<P, R>({
				params,
				tool,
				ts: Date.now(),
				dur_ms: durMs,
				resolveRepoKey,
				extractStatsParams,
				status: "error",
				err,
			});
			throw err;
		}
	};
}

function rkFromPath<P extends { path?: string }>(p: P): string | null {
	try {
		return resolveRepoIdentity(p.path ?? process.cwd()).repoKey;
	} catch {
		return null;
	}
}
function rkFromWorktree<P extends { worktreePath: string }>(p: P): string | null {
	try {
		return resolveRepoIdentity(p.worktreePath).repoKey;
	} catch {
		return null;
	}
}
function rkFromOptionalWorktree<P extends { worktreePath?: string }>(
	p: P,
): string | null {
	if (!p.worktreePath) return null;
	try {
		return resolveRepoIdentity(p.worktreePath).repoKey;
	} catch {
		return null;
	}
}
function libraryNowIso(): string {
	return new Date().toISOString();
}
const NO_STATS_PARAMS = (): null => null;
const NO_STATS_RESULT = (): null => null;

let noticeSent = false;
export function resetFirstCallNoticeForTest(): void {
	noticeSent = false;
}
export function hasNoticeBeenSent(): boolean {
	return noticeSent;
}

const reconciledKeys = new Set<string>();

export function resetReconciledKeys(): void {
	reconciledKeys.clear();
}

async function maybeReconcile(repoKey: string): Promise<void> {
	if (reconciledKeys.has(repoKey)) return;
	reconciledKeys.add(repoKey);
	try {
		await reconcileStore(repoKey, "mcp-startup");
	} catch (err) {
		process.stderr.write(
			`[ai-cortex] reconcile failed for ${repoKey}: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		reconciledKeys.delete(repoKey); // Allow retry next call
	}
}

async function withReconcileForRepoKey<R>(
	repoKey: string,
	fn: () => Promise<R>,
): Promise<R> {
	await maybeReconcile(repoKey);
	return fn();
}

export async function attachRelatedMemories<R extends { mode: SuggestMode; results: { path: string; score: number }[]; relatedMemories?: unknown }>(
	result: R,
	task: string,
	repoKey: string,
): Promise<R> {
	const top = result.results.map((r) => ({ path: r.path, score: r.score }));
	if (top.length === 0) return result;

	let projectRh: ReturnType<typeof openRetrieve> | null = null;
	let globalRh: ReturnType<typeof openRetrieve> | null = null;
	try {
		// v1: always re-embed task here. Reusing the semantic ranker's
		// embedding is deferred (preserves the suggestRepo() library boundary).
		// getProvider() can throw ModelLoadError; provider.embed() can throw
		// EmbeddingInferenceError — both must be inside the try so a model
		// failure never blocks the file response (spec §3.3.2).
		const provider = await getProvider();
		const [taskVec] = await provider.embed([task]);
		if (!taskVec) return result;

		await maybeReconcile(GLOBAL_REPO_KEY);
		projectRh = openRetrieve(repoKey);
		globalRh = openRetrieve(GLOBAL_REPO_KEY);
		const related = await matchMemoriesCrossTier(projectRh, globalRh, {
			mode: result.mode,
			topResults: top,
			taskVec,
		});
		if (related.length === 0) return result;
		return { ...result, relatedMemories: related };
	} catch {
		return result; // never block the file response on memory failure
	} finally {
		projectRh?.close();
		globalRh?.close();
	}
}

export async function withRepoIdentity<T>(
	worktreePath: string,
	fn: (repoKey: string) => Promise<T>,
): Promise<T> {
	validateWorktreePath(worktreePath);
	const { repoKey } = resolveRepoIdentity(worktreePath);
	await runRepoKeyMigrationIfNeeded(repoKey, worktreePath);
	return fn(repoKey);
}

function maybeNotice(): string {
	if (noticeSent) return "";
	noticeSent = true;
	if (isHistoryEnabled()) {
		return "<!-- history: capture active. disable with AI_CORTEX_HISTORY=0 or 'ai-cortex history off'. install hooks for best results: 'ai-cortex history install-hooks'. -->\n";
	}
	return "<!-- history: capture disabled. enable with AI_CORTEX_HISTORY=1 or 'ai-cortex history on'. -->\n";
}

async function embedQueryWithProvider(
	q: string,
): Promise<{ vector: Float32Array; modelName: string }> {
	const provider = await getProvider();
	const [vector] = await provider.embed([q]);
	return { vector, modelName: MODEL_NAME };
}

async function lazyCaptureCurrentSession(
	repoKey: string,
	cwd: string,
): Promise<void> {
	if (!isHistoryEnabled()) return;
	const detected = detectCurrentSession({ cwd });
	if (!detected) return;
	const transcriptPath = resolveTranscriptPath(cwd, detected.sessionId);
	if (!fs.existsSync(transcriptPath)) return;
	await captureSession({
		repoKey,
		sessionId: detected.sessionId,
		transcriptPath,
		embed: true,
	});
}

export type SearchHistoryArgs = {
	query: string;
	sessionId?: string;
	scope?: "session" | "project";
	limit?: number;
	path?: string;
};

export async function handleSearchHistory(
	args: SearchHistoryArgs,
): Promise<{ content: { type: "text"; text: string }[] }> {
	const cwd = args.path ?? process.cwd();
	let repoKey: string;
	try {
		repoKey = resolveRepoIdentity(cwd).repoKey;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			content: [
				{
					type: "text" as const,
					text: `${maybeNotice()}history: not in a git repo (${msg}). search_history requires a git repo for cache scoping.`,
				},
			],
		};
	}

	if (!args.sessionId) {
		try {
			await lazyCaptureCurrentSession(repoKey, cwd);
		} catch (err) {
			process.stderr.write(
				`[ai-cortex] history: lazy capture failed: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
	}

	const result = await searchHistory({
		repoKey,
		cwd,
		query: args.query,
		sessionId: args.sessionId,
		scope: args.scope,
		limit: args.limit,
		embedQuery: embedQueryWithProvider,
	});

	const lines: string[] = [maybeNotice()];
	if (result.error === "session-not-detected") {
		lines.push(
			"could not detect current session; pass sessionId, set AI_CORTEX_SESSION_ID, or use scope=project",
		);
	} else if (result.hits.length === 0) {
		lines.push("(no results)");
	} else {
		for (const h of result.hits) {
			lines.push(
				`[session ${h.sessionId} · ${h.kind}${h.turn !== null ? ` · turn ${h.turn}` : ""} · score ${h.score.toFixed(2)}]`,
			);
			lines.push(`> ${h.text.slice(0, 200)}`);
			lines.push("");
		}
		if (result.broadened) {
			lines.push(
				"(broadened to project scope: current session had no matches)",
			);
		}
	}
	return {
		content: [{ type: "text" as const, text: lines.join("\n").trimEnd() }],
	};
}

export function createServer(): McpServer {
	const server = new McpServer({ name: "ai-cortex", version: SERVER_VERSION });

	server.tool(
		"rehydrate_project",
		"Load project context for the current session. Call this once at the start of any session when working in a git repository. Returns a markdown briefing covering project structure, key files, entry points, and recent changes.",
		{ path: z.string().optional() },
		logged(
			"rehydrate_project",
			(p) => ({ path: p.path }),
			NO_STATS_PARAMS,
			rkFromPath,
			NO_STATS_RESULT,
			async ({ path: p }) => {
				const worktreePath = p ?? process.cwd();
				return withRepoIdentity(worktreePath, async (repoKey) => {
					// One-shot legacy capture triage: runs after the repo-key
					// migration + registry seed-merge (both inside
					// withRepoIdentity), before rehydrate. Sentinel-guarded →
					// once per repo on the first rehydrate_project after upgrade.
					const { runCaptureTriageIfNeeded } = await import(
						"../lib/memory/capture-triage.js",
					);
					await runCaptureTriageIfNeeded(repoKey);
					let updateNotice: string | null = null;
					let hookNotice: string | null = null;
					try {
						updateNotice = getBriefingNotice({
							currentVersion: SERVER_VERSION,
						});
					} catch {
						updateNotice = null;
					}
					try {
						hookNotice = getHookMigrationNotice();
					} catch {
						hookNotice = null;
					}
					const notice = [updateNotice, hookNotice]
						.filter((n): n is string => Boolean(n))
						.join("\n\n") || null;
					const result = await rehydrateRepo(worktreePath, { notice });
					const briefing = fs.readFileSync(result.briefingPath, "utf8");
					return {
						content: [
							{
								type: "text" as const,
								text: `<!-- cache: ${result.cacheStatus} -->\n${briefing}`,
							},
						],
					};
				});
			},
		),
	);

	server.registerTool(
		"suggest_files",
		{
			description:
				"USE FIRST for file discovery — call this before Grep or Glob when you " +
				"need to find which files are relevant to a task. Returns ranked files " +
				"using path tokens, function names, import/call graph, trigram fuzzy " +
				"match, and content scan. Fall back to Grep/Glob only for: exact-string " +
				"lookup of a known symbol, verifying edits, or when `suggest_files` " +
				"returns nothing useful. For explicit poolSize, use `suggest_files_deep`. " +
				"When the result is high-confidence and matching memories exist, the response also includes a `relatedMemories` array of pointers. Call `get_memory(id)` on any rule you intend to apply — surfacing alone does not count as use.",
			inputSchema: {
				task: z.string().min(1, "task must not be blank"),
				path: z.string().optional(),
				from: z.string().optional(),
				limit: z.number().int().positive().max(20).optional(),
				stale: z.boolean().optional(),
				verbose: z.boolean().optional(),
			},
			outputSchema: DeepSuggestResultSchema.shape,
		},
		logged(
			"suggest_files",
			(p) => ({ task: p.task, path: p.path }),
			(p) => ({ query_len: p.task.length }),
			rkFromPath,
			(r: { structuredContent: DeepSuggestResult }) => ({
				cache_status: r.structuredContent.cacheStatus,
				mode: r.structuredContent.mode,
				result_count: r.structuredContent.results.length,
			}),
			async ({ task, path, from, limit, stale, verbose }) => {
				const repoPath = path ?? process.cwd();
				const { repoKey } = resolveRepoIdentity(repoPath);
				return withReconcileForRepoKey(repoKey, async () => {
					const result = await suggestRepo(repoPath, task, {
						from,
						limit,
						stale,
						verbose,
						mode: "deep",
					});
					if (result.mode !== "deep") {
						throw new Error(
							"suggestRepo returned non-deep result for suggest_files",
						);
					}
					const enriched = await attachRelatedMemories(result, task, repoKey);
					return {
						content: [{ type: "text" as const, text: renderDeepText(enriched) }],
						structuredContent: enriched,
					};
				});
			},
		),
	);

	server.registerTool(
		"suggest_files_deep",
		{
			description:
				"Explicit deep search with pool size control. Same deep ranking as " +
				"suggest_files but accepts an additional poolSize parameter. Use when " +
				"you need to tune the candidate pool (e.g. larger pool for broad " +
				"queries on big repos). " +
				"When the result is high-confidence and matching memories exist, the response also includes a `relatedMemories` array of pointers. Call `get_memory(id)` on any rule you intend to apply — surfacing alone does not count as use.",
			inputSchema: {
				task: z.string().min(1, "task must not be blank"),
				path: z.string().optional(),
				from: z.string().optional(),
				limit: z.number().int().positive().max(20).optional(),
				stale: z.boolean().optional(),
				poolSize: z.number().int().positive().max(200).optional(),
				verbose: z.boolean().optional(),
			},
			outputSchema: DeepSuggestResultSchema.shape,
		},
		logged(
			"suggest_files_deep",
			(p) => ({ task: p.task, path: p.path, poolSize: p.poolSize }),
			(p) => ({ query_len: p.task.length }),
			rkFromPath,
			(r: { structuredContent: DeepSuggestResult }) => ({
				cache_status: r.structuredContent.cacheStatus,
				mode: r.structuredContent.mode,
				result_count: r.structuredContent.results.length,
			}),
			async ({ task, path, from, limit, stale, poolSize, verbose }) => {
				const repoPath = path ?? process.cwd();
				const { repoKey } = resolveRepoIdentity(repoPath);
				return withReconcileForRepoKey(repoKey, async () => {
					const result = await suggestRepo(repoPath, task, {
						from,
						limit,
						stale,
						poolSize,
						verbose,
						mode: "deep",
					});
					if (result.mode !== "deep") {
						throw new Error(
							"suggestRepo returned non-deep result for suggest_files_deep",
						);
					}
					const enriched = await attachRelatedMemories(result, task, repoKey);
					return {
						content: [{ type: "text" as const, text: renderDeepText(enriched) }],
						structuredContent: enriched,
					};
				});
			},
		),
	);

	server.registerTool(
		"suggest_files_semantic",
		{
			description:
				"Rank files by semantic similarity when the task is conceptual or " +
				"fuzzy and keyword/graph ranking (`suggest_files`) returns nothing " +
				"useful. Uses sentence embeddings (Xenova/all-MiniLM-L6-v2, 384-dim). " +
				"First call downloads ~23 MB model; subsequent calls are fast. " +
				"When the result is high-confidence and matching memories exist, the response also includes a `relatedMemories` array of pointers. Call `get_memory(id)` on any rule you intend to apply — surfacing alone does not count as use.",
			inputSchema: {
				task: z.string().min(1, "task must not be blank"),
				path: z.string().optional(),
				limit: z.number().int().positive().max(20).optional(),
				stale: z.boolean().optional(),
			},
			outputSchema: SemanticSuggestResultSchema.shape,
		},
		logged(
			"suggest_files_semantic",
			(p) => ({ task: p.task, path: p.path }),
			(p) => ({ query_len: p.task.length }),
			rkFromPath,
			(r: { structuredContent: SemanticSuggestResult }) => ({
				cache_status: r.structuredContent.cacheStatus,
				mode: r.structuredContent.mode,
				result_count: r.structuredContent.results.length,
			}),
			async ({ task, path, limit, stale }) => {
				const repoPath = path ?? process.cwd();
				const { repoKey } = resolveRepoIdentity(repoPath);
				return withReconcileForRepoKey(repoKey, async () => {
					const result = await suggestRepo(repoPath, task, {
						limit,
						stale,
						mode: "semantic",
					});
					if (result.mode !== "semantic") {
						throw new Error(
							"suggestRepo returned non-semantic result for suggest_files_semantic",
						);
					}
					const enriched = await attachRelatedMemories(result, task, repoKey);
					return {
						content: [
							{ type: "text" as const, text: renderSemanticText(enriched) },
						],
						structuredContent: enriched,
					};
				});
			},
		),
	);

	server.tool(
		"index_project",
		"Build or force-refresh the project index. Usually not needed — rehydrate_project handles freshness automatically. Use this to explicitly rebuild after large structural changes.",
		{ path: z.string().optional() },
		logged(
			"index_project",
			(p) => ({ path: p.path }),
			NO_STATS_PARAMS,
			rkFromPath,
			NO_STATS_RESULT,
			async ({ path }) => {
				const repoPath = path ?? process.cwd();
				const cache = await indexRepo(repoPath);
				return {
					content: [
						{
							type: "text" as const,
							text: `Indexed ${cache.files.length} files and ${cache.docs.length} docs.`,
						},
					],
				};
			},
		),
	);

	server.tool(
		"blast_radius",
		"Analyze what functions and files are affected if a given function is changed. " +
			"Returns callers organized by hop distance (direct, transitive) with export " +
			"visibility. Use before modifying a function to understand risk and plan testing. " +
			"For class methods, use Class.method format (e.g., 'Ranker.score').",
		{
			qualifiedName: z.string().min(1),
			file: z.string().min(1),
			path: z.string().optional(),
			maxHops: z.number().int().positive().optional(),
			stale: z.boolean().optional(),
		},
		logged(
			"blast_radius",
			(p) => ({ qualifiedName: p.qualifiedName, file: p.file, path: p.path }),
			NO_STATS_PARAMS,
			rkFromPath,
			(r: {
				structuredContent: { cacheStatus: "fresh" | "reindexed" | "stale" };
			}) => ({ cache_status: r.structuredContent.cacheStatus }),
			async ({ qualifiedName, file, path, maxHops, stale }) => {
				const repoPath = path ?? process.cwd();
				const identity = resolveRepoIdentity(repoPath);
				const { dbPath, cacheStatus } = await ensureFreshDb(identity, { stale });
				const result = queryBlastRadiusDb(
					dbPath,
					{ qualifiedName, file },
					maxHops ? { maxHops } : undefined,
				);
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(result, null, 2) },
					],
					structuredContent: { cacheStatus },
				};
			},
		),
	);

	server.registerTool(
		"search_history",
		{
			description:
				"Search compacted history of past agent sessions in this project. " +
				"Defaults to the current session. Use this to recover context lost to harness compaction " +
				"(decisions, file paths, user corrections, prior discussion). " +
				"Auto-broadens to the whole project if the current-session search returns nothing.",
			inputSchema: {
				query: z.string().min(1, "query must not be blank"),
				sessionId: z
					.string()
					.regex(/^[\w-]+$/)
					.optional(),
				scope: z.enum(["session", "project"]).optional(),
				limit: z.number().int().positive().max(50).optional(),
				path: z.string().optional(),
			},
		},
		logged(
			"search_history",
			(p: SearchHistoryArgs) => ({
				query: p.query,
				scope: p.scope,
				sessionId: p.sessionId,
			}),
			(p: SearchHistoryArgs) => ({ query_len: p.query?.length ?? 0 }),
			rkFromPath,
			NO_STATS_RESULT,
			handleSearchHistory,
		),
	);

	// ─── Memory read tools ────────────────────────────────────────────────────

	server.registerTool(
		"recall_memory",
		{
			description:
				"Browse stored project knowledge by query. Use BEFORE non-trivial edits to unfamiliar files, when debugging recurring symptoms, or when the user references a past decision. Pass scope.files for file-specific context; pass source: 'all' to include cross-project patterns. NOTE: this is browse-only and does not signal usage. To actually consult and use a result, follow up with get_memory(id). The store contains decisions, gotchas, how-tos, and patterns extracted from prior sessions.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				query: z.string().min(1),
				limit: z.number().int().positive().max(50).optional(),
				scopeFiles: z.array(z.string()).optional(),
				scopeTags: z.array(z.string()).optional(),
				type: z.string().optional(),
				source: z.enum(["project", "global", "all"]).optional(),
			},
		},
		logged(
			"recall_memory",
			(p) => ({ worktreePath: p.worktreePath, query: p.query }),
			(p) => ({ query_len: p.query.length }),
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					const source = p.source ?? "all";
					const opts = {
						limit: p.limit,
						scope: { files: p.scopeFiles, tags: p.scopeTags },
						type: p.type ? [p.type] : undefined,
					};

					let results;

					if (source === "global") {
						const rh = openRetrieve("global");
						try {
							results = await recallMemory(rh, p.query, opts);
						} finally {
							rh.close();
						}
					} else if (source === "all") {
						const projectRh = openRetrieve(repoKey);
						const globalRh = openRetrieve("global");
						try {
							results = await recallMemoryCrossTier(projectRh, globalRh, p.query, opts);
						} finally {
							projectRh.close();
							globalRh.close();
						}
					} else {
						const rh = openRetrieve(repoKey);
						try {
							results = await recallMemory(rh, p.query, opts);
						} finally {
							rh.close();
						}
					}

					return {
						content: [
							{ type: "text" as const, text: JSON.stringify(results, null, 2) },
						],
					};
				}),
			),
		),
	);

	server.registerTool(
		"get_memory",
		{
			description:
				"Fetch the full record for a memory by ID. Call this AFTER recall_memory returns a relevant hit and you intend to apply the rule, when the user references a memory by ID, or when verifying a rule before relying on it. Calling get_memory bumps the memory's access counter and last-access timestamp; recall_memory is browse-only and does not.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				id: z.string().min(1),
			},
		},
		logged(
			"get_memory",
			(p) => ({ worktreePath: p.worktreePath, id: p.id }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					const rh = openRetrieve(repoKey);
					try {
						const record = await getMemory(rh, p.id);
						try {
							appendGetEvent(repoKey, {
								ts: Date.now(),
								session_id: resolveLoggedSessionId(),
								memoryId: p.id,
							});
						} catch {
							/* telemetry is best-effort; never fail the read */
						}
						return {
							content: [
								{ type: "text" as const, text: JSON.stringify(record, null, 2) },
							],
						};
					} finally {
						rh.close();
					}
				}),
			),
		),
	);

	server.registerTool(
		"list_memories",
		{
			description:
				"List memories with optional filters by type, status, or file scope.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				type: z.array(z.string()).optional(),
				status: z.array(z.string()).optional(),
				scopeFile: z.string().optional(),
				limit: z.number().int().positive().max(200).optional(),
			},
		},
		logged(
			"list_memories",
			(p) => ({ worktreePath: p.worktreePath }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					const rh = openRetrieve(repoKey);
					try {
						const items = listMemories(rh, {
							type: p.type,
							status: p.status,
							scopeFile: p.scopeFile,
							limit: p.limit,
						});
						return {
							content: [
								{ type: "text" as const, text: JSON.stringify(items, null, 2) },
							],
						};
					} finally {
						rh.close();
					}
				}),
			),
		),
	);

	server.registerTool(
		"search_memories",
		{
			description:
				"Full-text search across memory bodies using FTS5. Returns ranked hits.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				query: z.string().min(1),
				limit: z.number().int().positive().max(50).optional(),
			},
		},
		logged(
			"search_memories",
			(p) => ({ worktreePath: p.worktreePath, query: p.query }),
			(p) => ({ query_len: p.query.length }),
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					const rh = openRetrieve(repoKey);
					try {
						const hits = searchMemories(rh, p.query, p.limit);
						return {
							content: [
								{ type: "text" as const, text: JSON.stringify(hits, null, 2) },
							],
						};
					} finally {
						rh.close();
					}
				}),
			),
		),
	);

	server.registerTool(
		"audit_memory",
		{
			description: "Return the full audit trail for a memory ID.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				id: z.string().min(1),
			},
		},
		logged(
			"audit_memory",
			(p) => ({ worktreePath: p.worktreePath, id: p.id }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					const rh = openRetrieve(repoKey);
					try {
						const rows = auditMemory(rh, p.id);
						return {
							content: [
								{ type: "text" as const, text: JSON.stringify(rows, null, 2) },
							],
						};
					} finally {
						rh.close();
					}
				}),
			),
		),
	);

	// ─── Memory write tools ───────────────────────────────────────────────────

	server.registerTool(
		"record_memory",
		{
			description:
				"Record a new memory when the user states a rule, expresses a preference, or describes a constraint. Good memories are specific, actionable, and scoped (pass scopeFiles when the rule is file-bound, scopeTags for cross-cutting concerns). Set globalScope=true for cross-project rules (universal language patterns, tool quirks). " + typeContractHint(),
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				type: z.string().min(1).describe(typeContractHint()),
				title: z.string().min(1),
				body: z.string().min(1),
				scopeFiles: z.array(z.string()).optional(),
				scopeTags: z.array(z.string()).optional(),
				source: z.enum(["explicit", "extracted"]).optional(),
				confidence: z.number().min(0).max(1).optional(),
				typeFields: z
					.record(z.unknown())
					.optional()
					.describe(
						"Type-specific fields. e.g. a gotcha takes { severity: 'info' | 'warning' | 'critical' } — defaults to 'warning' when omitted.",
					),
				globalScope: z.boolean().optional(),
			},
		},
		logged(
			"record_memory",
			(p) => ({ worktreePath: p.worktreePath, type: p.type, title: p.title }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					if (p.globalScope) await maybeReconcile(GLOBAL_REPO_KEY);
					const lc = p.globalScope
						? await openGlobalLifecycle({ agentId: "mcp" })
						: await openLifecycle(repoKey, { agentId: "mcp" });
					try {
						const id = await createMemory(lc, {
							type: p.type,
							title: p.title,
							body: p.body,
							scope: { files: p.scopeFiles ?? [], tags: p.scopeTags ?? [] },
							source: p.source ?? "explicit",
							confidence: p.confidence,
							typeFields: applyTypeFieldDefaults(p.type, p.typeFields),
						});
						return { content: [{ type: "text" as const, text: `${id}\n` }] };
					} finally {
						lc.close();
					}
				}),
			),
		),
	);

	server.registerTool(
		"update_memory",
		{
			description: "Update the body, title, or metadata of an existing memory.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				id: z.string().min(1),
				body: z.string().optional(),
				title: z.string().optional(),
				reason: z.string().optional(),
			},
		},
		logged(
			"update_memory",
			(p) => ({ worktreePath: p.worktreePath, id: p.id }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					const lc = await openLifecycle(repoKey, { agentId: "mcp" });
					try {
						await updateMemory(lc, p.id, {
							body: p.body,
							title: p.title,
							reason: p.reason,
						});
						return { content: [{ type: "text" as const, text: "ok\n" }] };
					} finally {
						lc.close();
					}
				}),
			),
		),
	);

	server.registerTool(
		"update_scope",
		{
			description: "Update the file/tag scope of a memory.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				id: z.string().min(1),
				scopeFiles: z.array(z.string()),
				scopeTags: z.array(z.string()),
			},
		},
		logged(
			"update_scope",
			(p) => ({ worktreePath: p.worktreePath, id: p.id }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					const lc = await openLifecycle(repoKey, { agentId: "mcp" });
					try {
						await updateScope(lc, p.id, {
							files: p.scopeFiles,
							tags: p.scopeTags,
						});
						return { content: [{ type: "text" as const, text: "ok\n" }] };
					} finally {
						lc.close();
					}
				}),
			),
		),
	);

	server.registerTool(
		"deprecate_memory",
		{
			description:
				"Deprecate a memory when its rule contradicts current code, conflicts with current user direction, or is otherwise no longer applicable. Deprecated memories are excluded from recall but preserved in audit. Use restore_memory to bring one back.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				id: z.string().min(1),
				reason: z.string().min(1),
			},
		},
		logged(
			"deprecate_memory",
			(p) => ({ worktreePath: p.worktreePath, id: p.id }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					const lc = await openLifecycle(repoKey, { agentId: "mcp" });
					try {
						await deprecateMemory(lc, p.id, p.reason);
						return { content: [{ type: "text" as const, text: "ok\n" }] };
					} finally {
						lc.close();
					}
				}),
			),
		),
	);

	server.registerTool(
		"restore_memory",
		{
			description: "Restore a deprecated memory back to active.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				id: z.string().min(1),
			},
		},
		logged(
			"restore_memory",
			(p) => ({ worktreePath: p.worktreePath, id: p.id }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					const lc = await openLifecycle(repoKey, { agentId: "mcp" });
					try {
						await restoreMemory(lc, p.id);
						return { content: [{ type: "text" as const, text: "ok\n" }] };
					} finally {
						lc.close();
					}
				}),
			),
		),
	);

	server.registerTool(
		"merge_memories",
		{
			description:
				"Merge src memory into dst. src becomes merged_into, dst receives the merged body.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				srcId: z.string().min(1),
				dstId: z.string().min(1),
				mergedBody: z.string().min(1),
			},
		},
		logged(
			"merge_memories",
			(p) => ({ worktreePath: p.worktreePath, srcId: p.srcId, dstId: p.dstId }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					const lc = await openLifecycle(repoKey, { agentId: "mcp" });
					try {
						await mergeMemories(lc, p.srcId, p.dstId, p.mergedBody);
						return { content: [{ type: "text" as const, text: "ok\n" }] };
					} finally {
						lc.close();
					}
				}),
			),
		),
	);

	server.registerTool(
		"trash_memory",
		{
			description: "Move a memory to trash. Recoverable via untrash_memory.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				id: z.string().min(1),
				reason: z.string().min(1),
			},
		},
		logged(
			"trash_memory",
			(p) => ({ worktreePath: p.worktreePath, id: p.id }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					const lc = await openLifecycle(repoKey, { agentId: "mcp" });
					try {
						await trashMemory(lc, p.id, p.reason);
						return { content: [{ type: "text" as const, text: "ok\n" }] };
					} finally {
						lc.close();
					}
				}),
			),
		),
	);

	server.registerTool(
		"untrash_memory",
		{
			description: "Restore a trashed memory back to active.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				id: z.string().min(1),
			},
		},
		logged(
			"untrash_memory",
			(p) => ({ worktreePath: p.worktreePath, id: p.id }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					const lc = await openLifecycle(repoKey, { agentId: "mcp" });
					try {
						await untrashMemory(lc, p.id);
						return { content: [{ type: "text" as const, text: "ok\n" }] };
					} finally {
						lc.close();
					}
				}),
			),
		),
	);

	server.registerTool(
		"purge_memory",
		{
			description:
				"Permanently delete a trashed memory. Use redact=true for privacy-grade erasure.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				id: z.string().min(1),
				reason: z.string().min(1),
				redact: z.boolean().optional(),
			},
		},
		logged(
			"purge_memory",
			(p) => ({ worktreePath: p.worktreePath, id: p.id }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					const lc = await openLifecycle(repoKey, { agentId: "mcp" });
					try {
						await purgeMemory(lc, p.id, p.reason, { redact: p.redact });
						return { content: [{ type: "text" as const, text: "ok\n" }] };
					} finally {
						lc.close();
					}
				}),
			),
		),
	);

	server.registerTool(
		"link_memories",
		{
			description: "Create a typed edge between two memories.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				srcId: z.string().min(1),
				dstId: z.string().min(1),
				relType: z.enum(["supports", "contradicts", "refines", "depends_on"]),
			},
		},
		logged(
			"link_memories",
			(p) => ({ worktreePath: p.worktreePath, srcId: p.srcId, dstId: p.dstId }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					const lc = await openLifecycle(repoKey, { agentId: "mcp" });
					try {
						await linkMemories(lc, p.srcId, p.dstId, p.relType);
						return { content: [{ type: "text" as const, text: "ok\n" }] };
					} finally {
						lc.close();
					}
				}),
			),
		),
	);

	server.registerTool(
		"unlink_memories",
		{
			description: "Remove a typed edge between two memories.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				srcId: z.string().min(1),
				dstId: z.string().min(1),
				relType: z.enum(["supports", "contradicts", "refines", "depends_on"]),
			},
		},
		logged(
			"unlink_memories",
			(p) => ({ worktreePath: p.worktreePath, srcId: p.srcId, dstId: p.dstId }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					const lc = await openLifecycle(repoKey, { agentId: "mcp" });
					try {
						await unlinkMemories(lc, p.srcId, p.dstId, p.relType);
						return { content: [{ type: "text" as const, text: "ok\n" }] };
					} finally {
						lc.close();
					}
				}),
			),
		),
	);

	server.registerTool(
		"pin_memory",
		{
			description: "Pin a memory so it appears in every rehydration briefing.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				id: z.string().min(1),
				force: z.boolean().optional(),
			},
		},
		logged(
			"pin_memory",
			(p) => ({ worktreePath: p.worktreePath, id: p.id }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					const lc = await openLifecycle(repoKey, { agentId: "mcp" });
					try {
						await pinMemory(lc, p.id, { force: p.force });
						return { content: [{ type: "text" as const, text: "ok\n" }] };
					} finally {
						lc.close();
					}
				}),
			),
		),
	);

	server.registerTool(
		"unpin_memory",
		{
			description: "Remove the explicit pin from a memory.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				id: z.string().min(1),
			},
		},
		logged(
			"unpin_memory",
			(p) => ({ worktreePath: p.worktreePath, id: p.id }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					const lc = await openLifecycle(repoKey, { agentId: "mcp" });
					try {
						await unpinMemory(lc, p.id);
						return { content: [{ type: "text" as const, text: "ok\n" }] };
					} finally {
						lc.close();
					}
				}),
			),
		),
	);

	server.registerTool(
		"confirm_memory",
		{
			description: "Confirm a candidate memory, promoting it to active. Call when the user explicitly endorses a candidate, or when the agent has used the rule successfully and validated it produced the right outcome. Note that rewrite_memory also auto-promotes candidate→active as a side effect of cleanup.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				id: z.string().min(1),
			},
		},
		logged(
			"confirm_memory",
			(p) => ({ worktreePath: p.worktreePath, id: p.id }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					const lc = await openLifecycle(repoKey, { agentId: "mcp" });
					try {
						await confirmMemory(lc, p.id);
						return { content: [{ type: "text" as const, text: "ok\n" }] };
					} finally {
						lc.close();
					}
				}),
			),
		),
	);

	server.registerTool(
		"add_evidence",
		{
			description: "Append a provenance entry to a memory's evidence trail.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				id: z.string().min(1),
				sessionId: z.string(),
				turn: z.number().int(),
				kind: z.enum([
					"user_correction",
					"user_prompt",
					"tool_call",
					"summary",
				]),
			},
		},
		logged(
			"add_evidence",
			(p) => ({ worktreePath: p.worktreePath, id: p.id }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					const lc = await openLifecycle(repoKey, { agentId: "mcp" });
					try {
						await addEvidence(lc, p.id, {
							sessionId: p.sessionId,
							turn: p.turn,
							kind: p.kind,
						});
						return { content: [{ type: "text" as const, text: "ok\n" }] };
					} finally {
						lc.close();
					}
				}),
			),
		),
	);

	server.registerTool(
		"rebuild_index",
		{
			description:
				"Reconcile the in-memory index with .md files on disk. Handles orphan files, phantom rows, and body-hash drift.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
			},
		},
		logged(
			"rebuild_index",
			(p) => ({ worktreePath: p.worktreePath }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					const report = await reconcileStore(repoKey, "mcp-rebuild");
					return {
						content: [
							{ type: "text" as const, text: JSON.stringify(report, null, 2) },
						],
					};
				}),
			),
		),
	);

	// ─── Aging sweep tool ────────────────────────────────────────────────────

	server.registerTool(
		"sweep_aging",
		{
			description:
				"Sweep aging transitions: trash stale candidates/deprecated/merged_into memories and purge old trashed memories. Use dryRun=true to preview without applying changes.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				dryRun: z.boolean().optional(),
			},
		},
		logged(
			"sweep_aging",
			(p) => ({ worktreePath: p.worktreePath }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					const { sweepAging } = await import("../lib/memory/aging.js");
					const report = await sweepAging(repoKey, { dryRun: p.dryRun });
					return {
						content: [
							{ type: "text" as const, text: JSON.stringify(report, null, 2) },
						],
					};
				}),
			),
		),
	);

	// ─── Promote to global tool ───────────────────────────────────────────────

	server.registerTool(
		"promote_to_global",
		{
			description:
				"Promote a project memory to the global cross-project store. The original is marked merged_into; the global copy gets a promotedFrom backref. Use for universal patterns, language quirks, and tool gotchas that apply across multiple projects.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				id: z.string().min(1),
			},
		},
		logged(
			"promote_to_global",
			(p) => ({ worktreePath: p.worktreePath, id: p.id }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					// withReconcileForRepoKey reconciles repoKey (project); explicitly reconcile
					// the global store too since that's the second write target.
					await maybeReconcile(GLOBAL_REPO_KEY);
					const lc = await openLifecycle(repoKey, { agentId: "mcp" });
					try {
						const globalId = await promoteToGlobal(lc, p.id);
						return {
							content: [{ type: "text" as const, text: `${globalId}\n` }],
						};
					} finally {
						lc.close();
					}
				}),
			),
		),
	);

	// ─── Auto-extractor tool ──────────────────────────────────────────────────

	server.registerTool(
		"extract_session",
		{
			description:
				"Run the auto-extractor on a captured session. Returns the manifest.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				sessionId: z.string().min(1),
				allowReExtract: z.boolean().optional(),
			},
		},
		logged(
			"extract_session",
			(p) => ({ worktreePath: p.worktreePath, sessionId: p.sessionId }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			(r) => {
				// `extractFromSession` returns an ExtractorManifest, JSON-stringified
				// in the single text content block. New-candidate count is the
				// numeric field `candidatesCreated` (src/lib/memory/extract.ts:37);
				// 0 on a re-extract that creates nothing (extract.ts:125).
				try {
					const m = JSON.parse(
						(r as { content: { text: string }[] }).content[0].text,
					) as { candidatesCreated?: unknown };
					const n =
						typeof m.candidatesCreated === "number" &&
						Number.isFinite(m.candidatesCreated)
							? m.candidatesCreated
							: 0;
					return { result_count: n };
				} catch {
					return { result_count: 0 };
				}
			},
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					const { extractFromSession } = await import("../lib/memory/extract.js");
					const manifest = await extractFromSession(repoKey, p.sessionId, {
						allowReExtract: p.allowReExtract === true,
					});
					return {
						content: [
							{ type: "text" as const, text: JSON.stringify(manifest, null, 2) },
						],
					};
				}),
			),
		),
	);

	server.registerTool(
		"capture_session",
		{
			description:
				"Capture a host-written transcript JSONL into the session history cache (parse → evidence → chunks → extractor). Host-agnostic: any host that writes a Claude-format transcript can call it.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				sessionId: z.string().min(1),
				transcriptPath: z.string().min(1).describe("Absolute path to the transcript JSONL the host wrote."),
				embed: z.boolean().optional(),
			},
		},
		logged(
			"capture_session",
			(p) => ({ worktreePath: p.worktreePath, sessionId: p.sessionId }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			(r) => {
				try {
					const m = JSON.parse((r as { content: { text: string }[] }).content[0].text) as {
						turnsProcessed?: unknown;
					};
					const n =
						typeof m.turnsProcessed === "number" && Number.isFinite(m.turnsProcessed)
							? m.turnsProcessed
							: 0;
					return { result_count: n };
				} catch {
					return { result_count: 0 };
				}
			},
			async (p) =>
				withRepoIdentity(p.worktreePath, async (repoKey) => {
					const { captureSession } = await import("../lib/history/capture.js");
					const result = await captureSession({
						repoKey,
						sessionId: p.sessionId,
						transcriptPath: p.transcriptPath,
						embed: p.embed !== false,
					});
					return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
				}),
		),
	);

	// ─── Subagent-driven cleanup ────────────────────────────────────────────────

	server.registerTool(
		"list_memories_pending_rewrite",
		{
			description:
				"List candidate memories eligible for cleanup. A candidate is eligible when it is `status=candidate` and has not yet been rewritten (`rewritten_at IS NULL`). Highest-confidence candidates are returned first. Pass `since` (ISO timestamp) to filter to candidates updated after that time — useful for incremental cleanup passes. Use this to drive subagent-based cleanup: dispatch a subagent with the returned candidates as context, have it rewrite each into a rule card (title + rule + rationale + when-applies), then call rewrite_memory for each. Captures (type='capture') are excluded — they are owned by the review_pending_captures flow.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				limit: z.number().int().positive().max(100).optional(),
				since: z
					.string()
					.optional()
					.describe(
						"ISO timestamp; if provided, returns only candidates with updated_at >= since",
					),
			},
		},
		logged(
			"list_memories_pending_rewrite",
			(p) => ({ worktreePath: p.worktreePath }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					const rh = openRetrieve(repoKey);
					try {
						const rows = listMemoriesPendingRewrite(rh, {
							limit: p.limit,
							since: p.since,
						});
						return {
							content: [
								{ type: "text" as const, text: JSON.stringify(rows, null, 2) },
							],
						};
					} finally {
						rh.close();
					}
				}),
			),
		),
	);

	server.registerTool(
		"review_pending_captures",
		{
			description:
				"List extracted memory captures pending agent confirmation (source=extracted, status=candidate) with source context, a signalScore ordering hint, and a tier field. Low-signal captures (signalScore 0) are hidden by default and auto-expire after 14 days untouched — pass includeLowSignal to audit them. Read-only. For each returned item: rewrite_memory(id,{type,...}) ALONE to keep (assigns the real type + promotes), or deprecate_memory(id,reason) to reject. Never call confirm_memory on a type:'capture' row.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				limit: z.number().int().positive().max(50).optional(),
				since: z
					.string()
					.optional()
					.describe(
						"ISO timestamp; if provided, returns only captures with updated_at > since",
					),
				includeLowSignal: z
					.boolean()
					.optional()
					.describe(
						"Include low-signal (signalScore 0) captures, which are hidden by default and auto-expire after 14 days untouched.",
					),
			},
		},
		logged(
			"review_pending_captures",
			(p) => ({ worktreePath: p.worktreePath }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					const { reviewPendingCaptures } = await import(
						"../lib/memory/pending-captures.js",
					);
					const items = await reviewPendingCaptures(repoKey, {
						limit: p.limit,
						since: p.since,
						includeLowSignal: p.includeLowSignal,
					});
					return {
						content: [
							{ type: "text" as const, text: JSON.stringify(items, null, 2) },
						],
					};
				}),
			),
		),
	);

	server.registerTool(
		"rewrite_memory",
		{
			description:
				"Apply a cleaned-up rewrite to a memory. The body should follow a soft rule card structure (rule + rationale + when-applies). rewrite_memory auto-promotes a candidate to active — your investment in rewriting is the endorsement signal. Errors on memories in terminal states (merged_into, trashed, purged_redacted). Already-active and deprecated memories keep their existing status (rewriting a deprecated memory does not auto-restore it). " + typeContractHint(),
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				id: z.string().min(1),
				title: z.string().min(1),
				body: z.string().min(1),
				scopeFiles: z.array(z.string()),
				scopeTags: z.array(z.string()),
				type: z.string().optional().describe(typeContractHint()),
				typeFields: z
					.record(z.unknown())
					.optional()
					.describe(
						"Type-specific fields. e.g. a gotcha takes { severity: 'info' | 'warning' | 'critical' } — defaults to 'warning' when omitted.",
					),
			},
		},
		logged(
			"rewrite_memory",
			(p) => ({ worktreePath: p.worktreePath, id: p.id }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			NO_STATS_RESULT,
			async (p) => withRepoIdentity(p.worktreePath, (repoKey) =>
				withReconcileForRepoKey(repoKey, async () => {
					const lc = await openLifecycle(repoKey, { agentId: "mcp" });
					try {
						await rewriteMemory(lc, p.id, {
							title: p.title,
							body: p.body,
							scopeFiles: p.scopeFiles,
							scopeTags: p.scopeTags,
							type: p.type,
							// Defaulting applies only when the caller retypes; with type
							// omitted the existing type and typeFields persist.
							typeFields: p.type
								? applyTypeFieldDefaults(p.type, p.typeFields)
								: p.typeFields,
						});
						return { content: [{ type: "text" as const, text: "ok\n" }] };
					} finally {
						lc.close();
					}
				}),
			),
		),
	);

	server.registerTool(
		"library_search",
		{
			description:
				"Search the cross-project document library for cited passages about a topic. Ranks documents from the current project first (origin affinity). Read-only; never gates on whether a result is consulted.",
			inputSchema: LibrarySearchInput,
			outputSchema: LibrarySearchResultSchema.shape,
		},
		logged(
			"library_search",
			(p) => ({ query: p.query, worktreePath: p.worktreePath }),
			(p) => ({ query_len: p.query.length }),
			rkFromOptionalWorktree,
			(r: { structuredContent: { hits: unknown[] } }) => ({
				result_count: r.structuredContent.hits.length,
			}),
			async (p) => {
				const currentRepoKey = rkFromOptionalWorktree(p) ?? undefined;
				// Pass cwd (the worktree) so searchLibrary auto-stamps the search with the
				// current session marker (sessionId + turn) for O6 downstream-touch.
				const hits = await searchLibrary(p.query, {
					ctx: { currentRepoKey, sourceFilter: p.sources, topN: p.topN },
					nowIso: libraryNowIso(),
					cwd: p.worktreePath,
				});
				const sourcesQueried =
					p.sources?.length ??
					libListSources().filter((s) => s.status === "ok").length;
				const text = hits.length
					? hits
							.map(
								(h) =>
									`- ${h.citation.relPath}:${h.citation.lineStart} (${h.origin.name})${h.freshness === "stale" ? " [stale]" : ""} ${h.snippet.slice(0, 160)}`,
							)
							.join("\n")
					: "No library results. Register a source with library_register_source.";
				return {
					content: [{ type: "text" as const, text }],
					structuredContent: { hits, sourcesQueried },
				};
			},
		),
	);

	server.registerTool(
		"library_register_source",
		{
			description:
				"Register a directory as a library source (opt-in). The library indexes nothing until a source is registered. Cache-only; never writes into the source.",
			inputSchema: LibraryRegisterInput,
		},
		logged(
			"library_register_source",
			(p) => ({ rootPath: p.rootPath }),
			NO_STATS_PARAMS,
			() => null,
			NO_STATS_RESULT,
			async (p) => {
				const { source, warnings } = libRegisterSource({
					rootPath: p.rootPath,
					label: p.label,
					include: p.include,
					exclude: p.exclude,
					nowIso: libraryNowIso(),
				});
				const text = [
					`registered ${source.origin.name} (${source.kind}) as ${source.id}`,
					...warnings.map((w) => `warning: ${w}`),
				].join("\n");
				return { content: [{ type: "text" as const, text }] };
			},
		),
	);

	server.registerTool(
		"library_list_sources",
		{
			description:
				"List registered library sources with status, last-indexed time, document count, and staleness.",
			inputSchema: {},
		},
		logged(
			"library_list_sources",
			() => ({}),
			NO_STATS_PARAMS,
			() => null,
			NO_STATS_RESULT,
			async () => {
				const sources = libListSourceStatuses({ staleness: true });
				const text = sources.length
					? sources
							.map(
								(s) =>
									`${s.id}  ${s.origin.name}  [${s.kind}]  ${s.status}  lastIndexed=${s.lastIndexedAt ?? "never"}  docs=${s.docCount}  stale=${s.staleCount ?? "n/a"}`,
							)
							.join("\n")
					: "no sources registered";
				return { content: [{ type: "text" as const, text }] };
			},
		),
	);

	server.registerTool(
		"library_reindex",
		{
			description:
				"Rebuild or refresh the library index for one source or all sources. Incremental by content hash and mtime.",
			inputSchema: LibraryReindexInput,
		},
		logged(
			"library_reindex",
			(p) => ({ sourceId: p.sourceId }),
			NO_STATS_PARAMS,
			() => null,
			NO_STATS_RESULT,
			async (p) => {
				const reports = await reindexLibrary({
					sourceId: p.sourceId,
					nowIso: libraryNowIso(),
				});
				const text = reports.length
					? reports
							.map(
								(r) =>
									`${r.name}: ${r.status} indexed=${r.docsIndexed} deleted=${r.docsDeleted} passages=${r.passages}${r.reason ? " reason=" + r.reason : ""}`,
							)
							.join("\n")
					: "no sources to reindex";
				return { content: [{ type: "text" as const, text }] };
			},
		),
	);

	return server;
}

function renderDeepText(r: DeepSuggestResult): string {
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

// Intentional copy of cli.ts renderSemanticText — keeps server and CLI independent.
function renderSemanticText(r: SemanticSuggestResult): string {
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

export async function startMcpServer(): Promise<void> {
	if (process.stdin.isTTY) {
		process.stderr.write(
			"[ai-cortex] MCP server uses stdio transport — it expects an MCP client\n" +
				"[ai-cortex] (Claude Code, Codex, etc.) to pipe JSON-RPC on stdin/stdout.\n" +
				"[ai-cortex] Running interactively is not useful. Press Ctrl+C to exit.\n",
		);
	}

	const server = createServer();
	const transport = new StdioServerTransport();

	const shutdown = async () => {
		process.stderr.write("[ai-cortex] shutting down MCP server\n");
		try {
			await server.close();
		} catch {
			// best-effort
		}
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	try {
		await server.connect(transport);
		process.stderr.write("[ai-cortex] MCP server started (stdio)\n");
	} catch (err) {
		process.stderr.write(
			`[ai-cortex] failed to start MCP server: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		process.exit(1);
	}

	// Explicitly wait for stdin to close before returning.
	// Without this, the process may exit before serving any requests in
	// environments where stdin is not automatically ref'd by the transport
	// (see: github.com/modelcontextprotocol/typescript-sdk/issues/202).
	await new Promise<void>((resolve) => process.stdin.on("close", resolve));
	process.stderr.write("[ai-cortex] stdin closed, MCP server exiting\n");
}
