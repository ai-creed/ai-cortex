import fs from "node:fs";
import Database from "better-sqlite3";
import type { BlastHit, CallEdge, FunctionNode, Range } from "./models.js";

export type BlastRadiusResult = {
	target: {
		qualifiedName: string;
		file: string;
		exported: boolean;
		range?: Range;
	};
	totalAffected: number;
	unresolvedEdges: number;
	confidence: "full" | "partial";
	tiers: BlastTier[];
	overloadCount?: number;
};

export type BlastTier = {
	hop: number;
	label: string;
	hits: BlastHit[];
};

export function queryBlastRadius(
	target: { qualifiedName: string; file: string },
	calls: CallEdge[],
	functions: FunctionNode[],
	options?: { maxHops?: number },
): BlastRadiusResult {
	const maxHops = options?.maxHops ?? 5;
	const targetKey = `${target.file}::${target.qualifiedName}`;

	const matchingFns = functions.filter(
		(f) => f.file === target.file && f.qualifiedName === target.qualifiedName,
	);
	const exported = matchingFns.some((f) => f.exported);
	const overloadCount = matchingFns.length > 1 ? matchingFns.length : undefined;

	// Build reverse adjacency: callee -> callers
	const reverseAdj = new Map<string, Set<string>>();
	for (const edge of calls) {
		if (edge.to.startsWith("::")) continue;
		let callers = reverseAdj.get(edge.to);
		if (!callers) {
			callers = new Set();
			reverseAdj.set(edge.to, callers);
		}
		callers.add(edge.from);
	}

	// BFS from target
	const visited = new Set<string>();
	visited.add(targetKey);
	const hitsByHop = new Map<number, BlastHit[]>();
	let frontier = [targetKey];
	let hop = 0;

	while (frontier.length > 0 && hop < maxHops) {
		hop++;
		const nextFrontier: string[] = [];
		for (const key of frontier) {
			const callers = reverseAdj.get(key);
			if (!callers) continue;
			for (const caller of callers) {
				if (visited.has(caller)) continue;
				visited.add(caller);
				nextFrontier.push(caller);

				const sepIdx = caller.indexOf("::");
				const callerFile = caller.slice(0, sepIdx);
				const callerName = caller.slice(sepIdx + 2);
				const callerFunc = functions.find(
					(f) => f.file === callerFile && f.qualifiedName === callerName,
				);

				const hit: BlastHit = {
					qualifiedName: callerName,
					file: callerFile,
					hop,
					exported: callerFunc?.exported ?? false,
				};

				const hitsAtHop = hitsByHop.get(hop) ?? [];
				hitsAtHop.push(hit);
				hitsByHop.set(hop, hitsAtHop);
			}
		}
		frontier = nextFrontier;
	}

	// Build tiers
	const tiers: BlastTier[] = [];
	for (const [h, hits] of [...hitsByHop.entries()].sort(
		(a, b) => a[0] - b[0],
	)) {
		const sorted = hits.sort(
			(a, b) =>
				a.file.localeCompare(b.file) ||
				a.qualifiedName.localeCompare(b.qualifiedName),
		);
		tiers.push({
			hop: h,
			label: h === 1 ? "direct callers" : `transitive callers (${h} hops)`,
			hits: sorted,
		});
	}

	const totalAffected = tiers.reduce((sum, t) => sum + t.hits.length, 0);

	// Count unresolved edges that could plausibly match target
	const targetMethodPortion = target.qualifiedName.includes(".")
		? target.qualifiedName.slice(target.qualifiedName.lastIndexOf(".") + 1)
		: null;

	let unresolvedEdges = 0;
	for (const edge of calls) {
		if (!edge.to.startsWith("::")) continue;
		const unresolvedName = edge.to.slice(2);
		if (unresolvedName === target.qualifiedName) {
			unresolvedEdges++;
		} else if (targetMethodPortion && unresolvedName === targetMethodPortion) {
			unresolvedEdges++;
		}
	}

	return {
		target: {
			qualifiedName: target.qualifiedName,
			file: target.file,
			exported,
		},
		totalAffected,
		unresolvedEdges,
		confidence: unresolvedEdges === 0 ? "full" : "partial",
		tiers,
		overloadCount,
	};
}

function splitKey(key: string): { file: string; name: string } {
	const i = key.indexOf("::");
	return { file: key.slice(0, i), name: key.slice(i + 2) };
}

/**
 * SQL-native blast radius: a readonly recursive CTE over the per-worktree .db
 * that walks reverse call edges from the target, never materializing the full
 * calls/functions arrays. Preserves queryBlastRadius's exact result semantics and
 * enriches hits/target with v3.1 function ranges and the deterministic call-site.
 */
export function queryBlastRadiusDb(
	dbPath: string,
	target: { qualifiedName: string; file: string },
	options?: { maxHops?: number },
): BlastRadiusResult {
	const maxHops = options?.maxHops ?? 5;
	const targetKey = `${target.file}::${target.qualifiedName}`;
	const db = new Database(dbPath, { readonly: true });
	try {
		// target export visibility + overload count
		const tfns = db
			.prepare(
				"SELECT exported FROM functions WHERE file = ? AND qualified_name = ?",
			)
			.all(target.file, target.qualifiedName) as Array<{ exported: number }>;
		const exported = tfns.some((r) => r.exported === 1);
		const overloadCount = tfns.length > 1 ? tfns.length : undefined;

		// reachable callers + min hop via recursive CTE (cycles bounded by maxHops).
		// Seed/recursed keys are always resolved (file::name), so an unresolved
		// ('::'-prefixed) to_key can never match to_key = b.key -> excluded naturally.
		const rows = db
			.prepare(
				`WITH RECURSIVE blast(key, hop) AS (
				   SELECT ?, 0
				   UNION
				   SELECT c.from_key, b.hop + 1
				   FROM blast b JOIN calls c ON c.to_key = b.key
				   WHERE b.hop < ?
				 )
				 SELECT key, MIN(hop) AS hop FROM blast WHERE key <> ? GROUP BY key`,
			)
			.all(targetKey, maxHops, targetKey) as Array<{
			key: string;
			hop: number;
		}>;

		const expStmt = db.prepare(
			"SELECT MAX(exported) AS e FROM functions WHERE file = ? AND qualified_name = ?",
		);
		const rangeStmt = db.prepare(
			"SELECT line, col, end_line, end_col FROM functions WHERE file = ? AND qualified_name = ? LIMIT 1",
		);
		const rangeOf = (file: string, name: string): Range | undefined => {
			const r = rangeStmt.get(file, name) as
				| {
						line: number;
						col: number | null;
						end_line: number | null;
						end_col: number | null;
				  }
				| undefined;
			if (!r || r.col === null || r.end_line === null || r.end_col === null)
				return undefined;
			return {
				line: r.line,
				column: r.col,
				endLine: r.end_line,
				endColumn: r.end_col,
			};
		};

		// keys present at each hop (hop 0 == the target) for callSite resolution
		const hopKeys = new Map<number, string[]>([[0, [targetKey]]]);
		for (const r of rows) {
			const arr = hopKeys.get(r.hop) ?? [];
			arr.push(r.key);
			hopKeys.set(r.hop, arr);
		}
		const callSiteOf = (
			callerKey: string,
			hop: number,
		): Range | undefined => {
			const callees = hopKeys.get(hop - 1) ?? [];
			if (callees.length === 0) return undefined;
			const placeholders = callees.map(() => "?").join(",");
			const row = db
				.prepare(
					`SELECT site_line, site_col, site_end_line, site_end_col
					 FROM calls
					 WHERE from_key = ? AND to_key IN (${placeholders}) AND site_line IS NOT NULL
					 ORDER BY site_line, site_col LIMIT 1`,
				)
				.get(callerKey, ...callees) as
				| {
						site_line: number;
						site_col: number;
						site_end_line: number;
						site_end_col: number;
				  }
				| undefined;
			if (!row) return undefined;
			return {
				line: row.site_line,
				column: row.site_col,
				endLine: row.site_end_line,
				endColumn: row.site_end_col,
			};
		};

		const hitsByHop = new Map<number, BlastHit[]>();
		for (const r of rows) {
			const { file, name } = splitKey(r.key);
			const e = expStmt.get(file, name) as { e: number | null } | undefined;
			const hit: BlastHit = {
				qualifiedName: name,
				file,
				hop: r.hop,
				exported: (e?.e ?? 0) === 1,
			};
			const range = rangeOf(file, name);
			if (range) hit.range = range;
			const callSite = callSiteOf(r.key, r.hop);
			if (callSite) hit.callSite = callSite;
			const arr = hitsByHop.get(r.hop) ?? [];
			arr.push(hit);
			hitsByHop.set(r.hop, arr);
		}

		// unresolved edge count (confidence). Method-portion clause only for dotted names.
		const methodPortion = target.qualifiedName.includes(".")
			? target.qualifiedName.slice(target.qualifiedName.lastIndexOf(".") + 1)
			: null;
		const unresolvedEdges = methodPortion
			? (
					db
						.prepare(
							"SELECT COUNT(*) AS c FROM calls WHERE to_key = ? OR to_key = ?",
						)
						.get(`::${target.qualifiedName}`, `::${methodPortion}`) as {
						c: number;
					}
				).c
			: (
					db
						.prepare("SELECT COUNT(*) AS c FROM calls WHERE to_key = ?")
						.get(`::${target.qualifiedName}`) as { c: number }
				).c;

		const tiers: BlastTier[] = [...hitsByHop.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([h, hits]) => ({
				hop: h,
				label:
					h === 1 ? "direct callers" : `transitive callers (${h} hops)`,
				hits: hits.sort(
					(a, b) =>
						a.file.localeCompare(b.file) ||
						a.qualifiedName.localeCompare(b.qualifiedName),
				),
			}));
		const totalAffected = tiers.reduce((s, t) => s + t.hits.length, 0);

		const targetRange = rangeOf(target.file, target.qualifiedName);
		return {
			target: {
				qualifiedName: target.qualifiedName,
				file: target.file,
				exported,
				...(targetRange ? { range: targetRange } : {}),
			},
			totalAffected,
			unresolvedEdges,
			confidence: unresolvedEdges === 0 ? "full" : "partial",
			tiers,
			overloadCount,
		};
	} finally {
		db.close();
		// A readonly open of a WAL-mode db creates regenerable -wal/-shm artifacts.
		// They never hold committed data here (writers replace the .db by atomic
		// rename, never by opening dbPath in WAL), so removing them after the read
		// keeps the cache dir clean and avoids stale sidecars next to the file.
		for (const sfx of ["-wal", "-shm"]) {
			fs.rmSync(dbPath + sfx, { force: true });
		}
	}
}
