import { openMemoryIndex, MemoryIndex } from "./index.js";
import { readMemoryFile } from "./store.js";
import type { MemoryRecord, AuditRow } from "./types.js";

export type RetrieveHandle = {
	repoKey: string;
	index: MemoryIndex;
	close: () => void;
};

export function openRetrieve(repoKey: string): RetrieveHandle {
	const index = openMemoryIndex(repoKey);
	return {
		repoKey,
		index,
		close() {
			index.close();
		},
	};
}

export async function getMemory(
	rh: RetrieveHandle,
	id: string,
): Promise<MemoryRecord> {
	const row = rh.index.getMemory(id);
	if (!row) throw new Error(`memory not found: ${id}`);
	const location = row.status === "trashed" ? "trash" : "memories";
	return readMemoryFile(rh.repoKey, id, location);
}

export type ListFilter = {
	type?: string[];
	status?: string[];
	scopeFile?: string;
	limit?: number;
};

export type ListItem = {
	id: string;
	type: string;
	status: string;
	title: string;
	updatedAt: string;
	bodyExcerpt: string;
};

export function listMemories(
	rh: RetrieveHandle,
	filter: ListFilter = {},
): ListItem[] {
	const where: string[] = [];
	const params: unknown[] = [];
	if (filter.type?.length) {
		where.push(`type IN (${filter.type.map(() => "?").join(",")})`);
		params.push(...filter.type);
	}
	if (filter.status?.length) {
		where.push(`status IN (${filter.status.map(() => "?").join(",")})`);
		params.push(...filter.status);
	}
	if (filter.scopeFile) {
		where.push(
			"EXISTS (SELECT 1 FROM memory_scope s WHERE s.memory_id=memories.id AND s.kind='file' AND s.value=?)",
		);
		params.push(filter.scopeFile);
	}
	const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
	const limit = filter.limit ?? 100;
	params.push(limit);
	const sql = `
		SELECT id, type, status, title, updated_at AS updatedAt, body_excerpt AS bodyExcerpt
		FROM memories ${whereSql} ORDER BY updated_at DESC LIMIT ?
	`;
	return rh.index
		.rawDb()
		.prepare(sql)
		.all(...params) as ListItem[];
}

export function auditMemory(rh: RetrieveHandle, id: string): AuditRow[] {
	return rh.index.auditRows(id);
}

export type SearchHit = {
	id: string;
	title: string;
	status: string;
	type: string;
	bodyExcerpt: string;
	rank: number;
};

export function searchMemories(
	rh: RetrieveHandle,
	query: string,
	limit = 10,
): SearchHit[] {
	const fts = rh.index.searchFts(query, limit);
	if (fts.length === 0) return [];
	const placeholders = fts.map(() => "?").join(",");
	const sql = `
		SELECT id, title, status, type, body_excerpt AS bodyExcerpt
		FROM memories WHERE id IN (${placeholders})
	`;
	const ranks = new Map(fts.map((h) => [h.memoryId, h.rank]));
	const rows = rh.index
		.rawDb()
		.prepare(sql)
		.all(...fts.map((h) => h.memoryId)) as Omit<SearchHit, "rank">[];
	return rows
		.map((r) => ({ ...r, rank: ranks.get(r.id) ?? 0 }))
		.sort((a, b) => a.rank - b.rank);
}

// ─── Task 6.2: Stage-1 scope filter ────────────────────────────────────────

export type RecallScope = { files?: string[]; tags?: string[] };

export type CandidateRow = {
	id: string;
	type: string;
	status: string;
	title: string;
	updatedAt: string;
	confidence: number;
	bodyHash: string;
	bodyExcerpt: string;
};

export function filterCandidates(
	rh: RetrieveHandle,
	opts: {
		scope?: RecallScope;
		type?: string[];
		includeStatus?: string[];
		candidatePoolSize: number;
	},
): CandidateRow[] {
	const files = opts.scope?.files ?? [];
	const tags = opts.scope?.tags ?? [];
	const hasScopeFilter = files.length > 0 || tags.length > 0;
	const types = opts.type ?? [];
	const statuses = opts.includeStatus ?? ["active", "candidate"];

	const where: string[] = [`status IN (${statuses.map(() => "?").join(",")})`];
	const params: unknown[] = [...statuses];

	if (types.length) {
		where.push(`type IN (${types.map(() => "?").join(",")})`);
		params.push(...types);
	}

	if (hasScopeFilter) {
		const scopeClauses: string[] = [];
		if (files.length) {
			scopeClauses.push(
				`EXISTS (SELECT 1 FROM memory_scope s WHERE s.memory_id=memories.id AND s.kind='file' AND s.value IN (${files.map(() => "?").join(",")}))`,
			);
			params.push(...files);
		}
		if (tags.length) {
			scopeClauses.push(
				`EXISTS (SELECT 1 FROM memory_scope s WHERE s.memory_id=memories.id AND s.kind='tag' AND s.value IN (${tags.map(() => "?").join(",")}))`,
			);
			params.push(...tags);
		}
		scopeClauses.push(
			"NOT EXISTS (SELECT 1 FROM memory_scope s WHERE s.memory_id=memories.id)",
		);
		where.push(`(${scopeClauses.join(" OR ")})`);
	}

	params.push(opts.candidatePoolSize);
	const sql = `
		SELECT id, type, status, title, updated_at AS updatedAt, confidence, body_hash AS bodyHash, body_excerpt AS bodyExcerpt
		FROM memories WHERE ${where.join(" AND ")} LIMIT ?
	`;
	return rh.index
		.rawDb()
		.prepare(sql)
		.all(...params) as CandidateRow[];
}

// ─── Task 6.3: Stage-2 ranker ──────────────────────────────────────────────

import { getProvider } from "../embed-provider.js";
import { readMemoryVector } from "./embed.js";
import { loadMemoryConfig } from "./config.js";

function cosine(a: Float32Array, b: Float32Array): number {
	let dot = 0,
		na = 0,
		nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

function statusWeight(status: string): number {
	if (status === "active") return 1.0;
	if (status === "candidate") return 0.5;
	if (status === "stale_reference") return 0.3;
	return 0;
}

function recencyDecay(updatedAt: string, halfLifeDays: number): number {
	const ageDays = (Date.now() - new Date(updatedAt).getTime()) / 86400e3;
	return Math.exp(-ageDays / halfLifeDays);
}

export type RecallResult = {
	id: string;
	title: string;
	type: string;
	status: string;
	bodyExcerpt: string;
	score: number;
	scope: { files: string[]; tags: string[] };
	links: { type: string; dstId: string }[];
};

export type RecallOptions = {
	scope?: RecallScope;
	type?: string[];
	includeStatus?: string[];
	limit?: number;
};

export async function recallMemory(
	rh: RetrieveHandle,
	query: string,
	options: RecallOptions = {},
): Promise<RecallResult[]> {
	const cfg = await loadMemoryConfig(rh.repoKey);
	const W = cfg.ranking.weights;
	const candidates = filterCandidates(rh, {
		scope: options.scope,
		type: options.type,
		includeStatus: options.includeStatus,
		candidatePoolSize: cfg.ranking.candidatePoolSize,
	});

	if (candidates.length === 0) return [];

	const provider = await getProvider();
	const [queryEmbedding] = await provider.embed([query]);
	const ranked: RecallResult[] = [];

	for (const c of candidates) {
		const v = await readMemoryVector(rh.repoKey, c.id);
		const semantic = v ? cosine(queryEmbedding!, v.vector) : 0;

		const scopeRows = rh.index.scopeRows(c.id);
		let scopeMatch = 0.2;
		if (scopeRows.length > 0) {
			const fileHit = scopeRows.some(
				(s) => s.kind === "file" && options.scope?.files?.includes(s.value),
			);
			const tagHit = scopeRows.some(
				(s) => s.kind === "tag" && options.scope?.tags?.includes(s.value),
			);
			if (fileHit) scopeMatch = 1.0;
			else if (tagHit) scopeMatch = 0.5;
			else scopeMatch = 0;
		}

		const score =
			W.semantic * semantic +
			W.scope * scopeMatch +
			W.status * statusWeight(c.status) +
			W.confidence * c.confidence +
			W.recency * recencyDecay(c.updatedAt, cfg.ranking.recencyHalfLifeDays);

		const links = rh.index
			.linksFrom(c.id)
			.map((l) => ({ type: l.relType, dstId: l.dstId }));
		ranked.push({
			id: c.id,
			title: c.title,
			type: c.type,
			status: c.status,
			bodyExcerpt: c.bodyExcerpt,
			score,
			links,
			scope: {
				files: scopeRows.filter((s) => s.kind === "file").map((s) => s.value),
				tags: scopeRows.filter((s) => s.kind === "tag").map((s) => s.value),
			},
		});
	}

	ranked.sort((a, b) => b.score - a.score);
	const limit = options.limit ?? cfg.ranking.topK;
	return ranked.slice(0, limit);
}

// ─── Task 4.3: Cross-tier recall ───────────────────────────────────────────

export type RecallSource = "project" | "global" | "all";

export async function recallMemoryCrossTier(
	projectRh: RetrieveHandle,
	globalRh: RetrieveHandle,
	query: string,
	options: RecallOptions,
): Promise<RecallResult[]> {
	const limit = options.limit ?? 10;
	const fetchOpts = { ...options, limit: limit * 2 };

	const [projectResults, globalResults] = await Promise.all([
		recallMemory(projectRh, query, fetchOpts),
		recallMemory(globalRh, query, fetchOpts),
	]);

	const SOURCE_BOOST = 0.1;
	const merged = [
		...projectResults.map((r) => ({ ...r, score: r.score + SOURCE_BOOST })),
		...globalResults,
	];
	merged.sort((a, b) => b.score - a.score);
	return merged.slice(0, limit);
}
