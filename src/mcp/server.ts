// src/mcp/server.ts
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
	indexRepo,
	rehydrateRepo,
	suggestRepo,
	queryBlastRadius,
} from "../lib/index.js";
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
import { resolveRepoIdentity } from "../lib/repo-identity.js";
import { getProvider, MODEL_NAME } from "../lib/embed-provider.js";
import { VERSION as SERVER_VERSION } from "../version.js";
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
import { reconcileStore } from "../lib/memory/reconcile.js";

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

function logged<P, R>(
	tool: string,
	extractMeta: (params: P) => Record<string, unknown>,
	handler: (params: P) => Promise<R>,
): (params: P) => Promise<R> {
	return async (params: P) => {
		const t0 = performance.now();
		try {
			const result = await handler(params);
			logCall(
				tool,
				extractMeta(params),
				Math.round(performance.now() - t0),
				"ok",
			);
			return result;
		} catch (err) {
			logCall(
				tool,
				extractMeta(params),
				Math.round(performance.now() - t0),
				"error",
				err,
			);
			throw err;
		}
	};
}

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

function withReconcile<P extends { repoKey: string }, R>(
	handler: (p: P) => Promise<R>,
): (p: P) => Promise<R> {
	return async (p: P) => {
		await maybeReconcile(p.repoKey);
		return handler(p);
	};
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
			async ({ path }) => {
				const repoPath = path ?? process.cwd();
				const result = await rehydrateRepo(repoPath);
				const briefing = fs.readFileSync(result.briefingPath, "utf8");
				return {
					content: [
						{
							type: "text" as const,
							text: `<!-- cache: ${result.cacheStatus} -->\n${briefing}`,
						},
					],
				};
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
				"returns nothing useful. For explicit poolSize, use `suggest_files_deep`.",
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
			async ({ task, path, from, limit, stale, verbose }) => {
				const repoPath = path ?? process.cwd();
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
				return {
					content: [{ type: "text" as const, text: renderDeepText(result) }],
					structuredContent: result,
				};
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
				"queries on big repos).",
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
			async ({ task, path, from, limit, stale, poolSize, verbose }) => {
				const repoPath = path ?? process.cwd();
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
				return {
					content: [{ type: "text" as const, text: renderDeepText(result) }],
					structuredContent: result,
				};
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
				"First call downloads ~23 MB model; subsequent calls are fast.",
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
			async ({ task, path, limit, stale }) => {
				const repoPath = path ?? process.cwd();
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
				return {
					content: [
						{ type: "text" as const, text: renderSemanticText(result) },
					],
					structuredContent: result,
				};
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
			async ({ qualifiedName, file, path, maxHops, stale }) => {
				const repoPath = path ?? process.cwd();
				const { cache } = await rehydrateRepo(repoPath, { stale });
				const result = queryBlastRadius(
					{ qualifiedName, file },
					cache.calls ?? [],
					cache.functions ?? [],
					maxHops ? { maxHops } : undefined,
				);
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(result, null, 2) },
					],
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
				repoKey: z
					.string()
					.describe("Project repo key (from rehydrate_project)"),
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
			(p) => ({ repoKey: p.repoKey, query: p.query }),
			withReconcile(async (p) => {
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
					const projectRh = openRetrieve(p.repoKey);
					const globalRh = openRetrieve("global");
					try {
						results = await recallMemoryCrossTier(projectRh, globalRh, p.query, opts);
					} finally {
						projectRh.close();
						globalRh.close();
					}
				} else {
					const rh = openRetrieve(p.repoKey);
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
	);

	server.registerTool(
		"get_memory",
		{
			description:
				"Fetch the full record for a memory by ID. Call this AFTER recall_memory returns a relevant hit and you intend to apply the rule, when the user references a memory by ID, or when verifying a rule before relying on it. get_memory is the 'I am using this' signal — it counts toward cleanup eligibility, while recall_memory does not.",
			inputSchema: {
				repoKey: z.string(),
				id: z.string().min(1),
			},
		},
		logged(
			"get_memory",
			(p) => ({ repoKey: p.repoKey, id: p.id }),
			withReconcile(async (p) => {
				const rh = openRetrieve(p.repoKey);
				try {
					const record = await getMemory(rh, p.id);
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
	);

	server.registerTool(
		"list_memories",
		{
			description:
				"List memories with optional filters by type, status, or file scope.",
			inputSchema: {
				repoKey: z.string(),
				type: z.array(z.string()).optional(),
				status: z.array(z.string()).optional(),
				scopeFile: z.string().optional(),
				limit: z.number().int().positive().max(200).optional(),
			},
		},
		logged(
			"list_memories",
			(p) => ({ repoKey: p.repoKey }),
			withReconcile(async (p) => {
				const rh = openRetrieve(p.repoKey);
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
	);

	server.registerTool(
		"search_memories",
		{
			description:
				"Full-text search across memory bodies using FTS5. Returns ranked hits.",
			inputSchema: {
				repoKey: z.string(),
				query: z.string().min(1),
				limit: z.number().int().positive().max(50).optional(),
			},
		},
		logged(
			"search_memories",
			(p) => ({ repoKey: p.repoKey, query: p.query }),
			withReconcile(async (p) => {
				const rh = openRetrieve(p.repoKey);
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
	);

	server.registerTool(
		"audit_memory",
		{
			description: "Return the full audit trail for a memory ID.",
			inputSchema: {
				repoKey: z.string(),
				id: z.string().min(1),
			},
		},
		logged(
			"audit_memory",
			(p) => ({ repoKey: p.repoKey, id: p.id }),
			withReconcile(async (p) => {
				const rh = openRetrieve(p.repoKey);
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
	);

	// ─── Memory write tools ───────────────────────────────────────────────────

	server.registerTool(
		"record_memory",
		{
			description:
				"Record a new memory when the user states a rule, expresses a preference, or describes a constraint. Good memories are specific, actionable, and scoped (pass scopeFiles when the rule is file-bound, scopeTags for cross-cutting concerns). Set globalScope=true for cross-project rules (universal language patterns, tool quirks).",
			inputSchema: {
				repoKey: z.string(),
				type: z.string().min(1),
				title: z.string().min(1),
				body: z.string().min(1),
				scopeFiles: z.array(z.string()).optional(),
				scopeTags: z.array(z.string()).optional(),
				source: z.enum(["explicit", "extracted"]).optional(),
				confidence: z.number().min(0).max(1).optional(),
				typeFields: z.record(z.unknown()).optional(),
				globalScope: z.boolean().optional(),
			},
		},
		logged(
			"record_memory",
			(p) => ({ repoKey: p.repoKey, type: p.type, title: p.title }),
			withReconcile(async (p) => {
				if (p.globalScope) await maybeReconcile(GLOBAL_REPO_KEY);
				const lc = p.globalScope
					? await openGlobalLifecycle({ agentId: "mcp" })
					: await openLifecycle(p.repoKey, { agentId: "mcp" });
				try {
					const id = await createMemory(lc, {
						type: p.type,
						title: p.title,
						body: p.body,
						scope: { files: p.scopeFiles ?? [], tags: p.scopeTags ?? [] },
						source: p.source ?? "explicit",
						confidence: p.confidence,
						typeFields: p.typeFields,
					});
					return { content: [{ type: "text" as const, text: `${id}\n` }] };
				} finally {
					lc.close();
				}
			}),
		),
	);

	server.registerTool(
		"update_memory",
		{
			description: "Update the body, title, or metadata of an existing memory.",
			inputSchema: {
				repoKey: z.string(),
				id: z.string().min(1),
				body: z.string().optional(),
				title: z.string().optional(),
				reason: z.string().optional(),
			},
		},
		logged(
			"update_memory",
			(p) => ({ repoKey: p.repoKey, id: p.id }),
			withReconcile(async (p) => {
				const lc = await openLifecycle(p.repoKey, { agentId: "mcp" });
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
	);

	server.registerTool(
		"update_scope",
		{
			description: "Update the file/tag scope of a memory.",
			inputSchema: {
				repoKey: z.string(),
				id: z.string().min(1),
				scopeFiles: z.array(z.string()),
				scopeTags: z.array(z.string()),
			},
		},
		logged(
			"update_scope",
			(p) => ({ repoKey: p.repoKey, id: p.id }),
			withReconcile(async (p) => {
				const lc = await openLifecycle(p.repoKey, { agentId: "mcp" });
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
	);

	server.registerTool(
		"deprecate_memory",
		{
			description:
				"Deprecate a memory when its rule contradicts current code, conflicts with current user direction, or is otherwise no longer applicable. Deprecated memories are excluded from recall but preserved in audit. Use restore_memory to bring one back.",
			inputSchema: {
				repoKey: z.string(),
				id: z.string().min(1),
				reason: z.string().min(1),
			},
		},
		logged(
			"deprecate_memory",
			(p) => ({ repoKey: p.repoKey, id: p.id }),
			withReconcile(async (p) => {
				const lc = await openLifecycle(p.repoKey, { agentId: "mcp" });
				try {
					await deprecateMemory(lc, p.id, p.reason);
					return { content: [{ type: "text" as const, text: "ok\n" }] };
				} finally {
					lc.close();
				}
			}),
		),
	);

	server.registerTool(
		"restore_memory",
		{
			description: "Restore a deprecated memory back to active.",
			inputSchema: {
				repoKey: z.string(),
				id: z.string().min(1),
			},
		},
		logged(
			"restore_memory",
			(p) => ({ repoKey: p.repoKey, id: p.id }),
			withReconcile(async (p) => {
				const lc = await openLifecycle(p.repoKey, { agentId: "mcp" });
				try {
					await restoreMemory(lc, p.id);
					return { content: [{ type: "text" as const, text: "ok\n" }] };
				} finally {
					lc.close();
				}
			}),
		),
	);

	server.registerTool(
		"merge_memories",
		{
			description:
				"Merge src memory into dst. src becomes merged_into, dst receives the merged body.",
			inputSchema: {
				repoKey: z.string(),
				srcId: z.string().min(1),
				dstId: z.string().min(1),
				mergedBody: z.string().min(1),
			},
		},
		logged(
			"merge_memories",
			(p) => ({ repoKey: p.repoKey, srcId: p.srcId, dstId: p.dstId }),
			withReconcile(async (p) => {
				const lc = await openLifecycle(p.repoKey, { agentId: "mcp" });
				try {
					await mergeMemories(lc, p.srcId, p.dstId, p.mergedBody);
					return { content: [{ type: "text" as const, text: "ok\n" }] };
				} finally {
					lc.close();
				}
			}),
		),
	);

	server.registerTool(
		"trash_memory",
		{
			description: "Move a memory to trash. Recoverable via untrash_memory.",
			inputSchema: {
				repoKey: z.string(),
				id: z.string().min(1),
				reason: z.string().min(1),
			},
		},
		logged(
			"trash_memory",
			(p) => ({ repoKey: p.repoKey, id: p.id }),
			withReconcile(async (p) => {
				const lc = await openLifecycle(p.repoKey, { agentId: "mcp" });
				try {
					await trashMemory(lc, p.id, p.reason);
					return { content: [{ type: "text" as const, text: "ok\n" }] };
				} finally {
					lc.close();
				}
			}),
		),
	);

	server.registerTool(
		"untrash_memory",
		{
			description: "Restore a trashed memory back to active.",
			inputSchema: {
				repoKey: z.string(),
				id: z.string().min(1),
			},
		},
		logged(
			"untrash_memory",
			(p) => ({ repoKey: p.repoKey, id: p.id }),
			withReconcile(async (p) => {
				const lc = await openLifecycle(p.repoKey, { agentId: "mcp" });
				try {
					await untrashMemory(lc, p.id);
					return { content: [{ type: "text" as const, text: "ok\n" }] };
				} finally {
					lc.close();
				}
			}),
		),
	);

	server.registerTool(
		"purge_memory",
		{
			description:
				"Permanently delete a trashed memory. Use redact=true for privacy-grade erasure.",
			inputSchema: {
				repoKey: z.string(),
				id: z.string().min(1),
				reason: z.string().min(1),
				redact: z.boolean().optional(),
			},
		},
		logged(
			"purge_memory",
			(p) => ({ repoKey: p.repoKey, id: p.id }),
			withReconcile(async (p) => {
				const lc = await openLifecycle(p.repoKey, { agentId: "mcp" });
				try {
					await purgeMemory(lc, p.id, p.reason, { redact: p.redact });
					return { content: [{ type: "text" as const, text: "ok\n" }] };
				} finally {
					lc.close();
				}
			}),
		),
	);

	server.registerTool(
		"link_memories",
		{
			description: "Create a typed edge between two memories.",
			inputSchema: {
				repoKey: z.string(),
				srcId: z.string().min(1),
				dstId: z.string().min(1),
				relType: z.enum(["supports", "contradicts", "refines", "depends_on"]),
			},
		},
		logged(
			"link_memories",
			(p) => ({ repoKey: p.repoKey, srcId: p.srcId, dstId: p.dstId }),
			withReconcile(async (p) => {
				const lc = await openLifecycle(p.repoKey, { agentId: "mcp" });
				try {
					await linkMemories(lc, p.srcId, p.dstId, p.relType);
					return { content: [{ type: "text" as const, text: "ok\n" }] };
				} finally {
					lc.close();
				}
			}),
		),
	);

	server.registerTool(
		"unlink_memories",
		{
			description: "Remove a typed edge between two memories.",
			inputSchema: {
				repoKey: z.string(),
				srcId: z.string().min(1),
				dstId: z.string().min(1),
				relType: z.enum(["supports", "contradicts", "refines", "depends_on"]),
			},
		},
		logged(
			"unlink_memories",
			(p) => ({ repoKey: p.repoKey, srcId: p.srcId, dstId: p.dstId }),
			withReconcile(async (p) => {
				const lc = await openLifecycle(p.repoKey, { agentId: "mcp" });
				try {
					await unlinkMemories(lc, p.srcId, p.dstId, p.relType);
					return { content: [{ type: "text" as const, text: "ok\n" }] };
				} finally {
					lc.close();
				}
			}),
		),
	);

	server.registerTool(
		"pin_memory",
		{
			description: "Pin a memory so it appears in every rehydration briefing.",
			inputSchema: {
				repoKey: z.string(),
				id: z.string().min(1),
				force: z.boolean().optional(),
			},
		},
		logged(
			"pin_memory",
			(p) => ({ repoKey: p.repoKey, id: p.id }),
			withReconcile(async (p) => {
				const lc = await openLifecycle(p.repoKey, { agentId: "mcp" });
				try {
					await pinMemory(lc, p.id, { force: p.force });
					return { content: [{ type: "text" as const, text: "ok\n" }] };
				} finally {
					lc.close();
				}
			}),
		),
	);

	server.registerTool(
		"unpin_memory",
		{
			description: "Remove the explicit pin from a memory.",
			inputSchema: {
				repoKey: z.string(),
				id: z.string().min(1),
			},
		},
		logged(
			"unpin_memory",
			(p) => ({ repoKey: p.repoKey, id: p.id }),
			withReconcile(async (p) => {
				const lc = await openLifecycle(p.repoKey, { agentId: "mcp" });
				try {
					await unpinMemory(lc, p.id);
					return { content: [{ type: "text" as const, text: "ok\n" }] };
				} finally {
					lc.close();
				}
			}),
		),
	);

	server.registerTool(
		"confirm_memory",
		{
			description: "Confirm a candidate memory, promoting it to active. Call when the user explicitly endorses a candidate, or when the agent has used the rule successfully and validated it produced the right outcome. Note that rewrite_memory also auto-promotes candidate→active as a side effect of cleanup.",
			inputSchema: {
				repoKey: z.string(),
				id: z.string().min(1),
			},
		},
		logged(
			"confirm_memory",
			(p) => ({ repoKey: p.repoKey, id: p.id }),
			withReconcile(async (p) => {
				const lc = await openLifecycle(p.repoKey, { agentId: "mcp" });
				try {
					await confirmMemory(lc, p.id);
					return { content: [{ type: "text" as const, text: "ok\n" }] };
				} finally {
					lc.close();
				}
			}),
		),
	);

	server.registerTool(
		"add_evidence",
		{
			description: "Append a provenance entry to a memory's evidence trail.",
			inputSchema: {
				repoKey: z.string(),
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
			(p) => ({ repoKey: p.repoKey, id: p.id }),
			withReconcile(async (p) => {
				const lc = await openLifecycle(p.repoKey, { agentId: "mcp" });
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
	);

	server.registerTool(
		"rebuild_index",
		{
			description:
				"Reconcile the in-memory index with .md files on disk. Handles orphan files, phantom rows, and body-hash drift.",
			inputSchema: {
				repoKey: z.string(),
			},
		},
		logged(
			"rebuild_index",
			(p) => ({ repoKey: p.repoKey }),
			withReconcile(async (p) => {
				const report = await reconcileStore(p.repoKey, "mcp-rebuild");
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(report, null, 2) },
					],
				};
			}),
		),
	);

	// ─── Aging sweep tool ────────────────────────────────────────────────────

	server.registerTool(
		"sweep_aging",
		{
			description:
				"Sweep aging transitions: trash stale candidates/deprecated/merged_into memories and purge old trashed memories. Use dryRun=true to preview without applying changes.",
			inputSchema: {
				repoKey: z.string(),
				dryRun: z.boolean().optional(),
			},
		},
		logged(
			"sweep_aging",
			(p) => ({ repoKey: p.repoKey }),
			withReconcile(async (p) => {
				const { sweepAging } = await import("../lib/memory/aging.js");
				const report = await sweepAging(p.repoKey, { dryRun: p.dryRun });
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(report, null, 2) },
					],
				};
			}),
		),
	);

	// ─── Promote to global tool ───────────────────────────────────────────────

	server.registerTool(
		"promote_to_global",
		{
			description:
				"Promote a project memory to the global cross-project store. The original is marked merged_into; the global copy gets a promotedFrom backref. Use for universal patterns, language quirks, and tool gotchas that apply across multiple projects.",
			inputSchema: {
				repoKey: z.string(),
				id: z.string().min(1),
			},
		},
		logged(
			"promote_to_global",
			(p) => ({ repoKey: p.repoKey, id: p.id }),
			withReconcile(async (p) => {
				// withReconcile reconciles p.repoKey (project); explicitly reconcile
				// the global store too since that's the second write target.
				await maybeReconcile(GLOBAL_REPO_KEY);
				const lc = await openLifecycle(p.repoKey, { agentId: "mcp" });
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
	);

	// ─── Auto-extractor tool ──────────────────────────────────────────────────

	server.registerTool(
		"extract_session",
		{
			description:
				"Run the auto-extractor on a captured session. Returns the manifest.",
			inputSchema: {
				repoKey: z.string(),
				sessionId: z.string().min(1),
				allowReExtract: z.boolean().optional(),
			},
		},
		logged(
			"extract_session",
			(p) => ({ repoKey: p.repoKey, sessionId: p.sessionId }),
			withReconcile(async (p) => {
				const { extractFromSession } = await import("../lib/memory/extract.js");
				const manifest = await extractFromSession(p.repoKey, p.sessionId, {
					allowReExtract: p.allowReExtract === true,
				});
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(manifest, null, 2) },
					],
				};
			}),
		),
	);

	// ─── Subagent-driven cleanup ────────────────────────────────────────────────

	server.registerTool(
		"list_memories_pending_rewrite",
		{
			description:
				"List candidate memories eligible for cleanup. A candidate is eligible when it has been re-extracted at least once AND is either pinned OR has been accessed via get_memory. Pass `since` (ISO timestamp) to filter to candidates updated after that time — useful for incremental cleanup passes. Use this to drive subagent-based cleanup: dispatch a subagent with the returned candidates as context, have it rewrite each into a rule card (title + rule + rationale + when-applies), then call rewrite_memory for each.",
			inputSchema: {
				repoKey: z.string(),
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
			(p) => ({ repoKey: p.repoKey }),
			withReconcile(async (p) => {
				const rh = openRetrieve(p.repoKey);
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
	);

	server.registerTool(
		"rewrite_memory",
		{
			description:
				"Apply a cleaned-up rewrite to a memory. The body should follow a soft rule card structure (rule + rationale + when-applies). rewrite_memory auto-promotes a candidate to active — your investment in rewriting is the endorsement signal. Errors on memories in terminal states (merged_into, trashed, purged_redacted). Already-active and deprecated memories keep their existing status (rewriting a deprecated memory does not auto-restore it).",
			inputSchema: {
				repoKey: z.string(),
				id: z.string().min(1),
				title: z.string().min(1),
				body: z.string().min(1),
				scopeFiles: z.array(z.string()),
				scopeTags: z.array(z.string()),
				type: z.string().optional(),
				typeFields: z.record(z.unknown()).optional(),
			},
		},
		logged(
			"rewrite_memory",
			(p) => ({ repoKey: p.repoKey, id: p.id }),
			withReconcile(async (p) => {
				const lc = await openLifecycle(p.repoKey, { agentId: "mcp" });
				try {
					await rewriteMemory(lc, p.id, {
						title: p.title,
						body: p.body,
						scopeFiles: p.scopeFiles,
						scopeTags: p.scopeTags,
						type: p.type,
						typeFields: p.typeFields,
					});
					return { content: [{ type: "text" as const, text: "ok\n" }] };
				} finally {
					lc.close();
				}
			}),
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
