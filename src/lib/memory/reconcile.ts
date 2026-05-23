import crypto from "node:crypto";
import { openMemoryIndex } from "./index.js";
import type { MemoryIndex } from "./index.js";
import { listMemoryFiles, readMemoryFile, writeMemoryFile } from "./store.js";
import { upsertMemoryVector, deleteMemoryVector } from "./embed.js";
import { bodyExcerpt } from "./markdown.js";
import { parseLegacyScopeTrailer } from "./legacy-scope.js";
import type { AuditRow } from "./types.js";

export type ReconcileReport = {
	reindexed: string[];
	adopted: string[];
	phantomsRemoved: string[];
	legacyRepaired: string[];
};

function safeAppendAudit(index: MemoryIndex, row: AuditRow): void {
	try {
		index.appendAudit(row);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (
			!msg.includes(
				"UNIQUE constraint failed: memory_audit.memory_id, memory_audit.version",
			)
		) {
			throw err;
		}
		// A row with this (memoryId, version) already exists from a prior partial run.
		// Bump version to one past the current max and retry.
		const next = index.maxAuditVersion(row.memoryId) + 1;
		index.appendAudit({ ...row, version: next });
	}
}

function bodyHash(title: string, body: string): string {
	return crypto
		.createHash("sha256")
		.update(title)
		.update("\n\n")
		.update(body)
		.digest("hex");
}

export async function reconcileStore(
	repoKey: string,
	agentId: string | null = null,
): Promise<ReconcileReport> {
	const index = openMemoryIndex(repoKey);
	const report: ReconcileReport = {
		reindexed: [],
		adopted: [],
		phantomsRemoved: [],
		legacyRepaired: [],
	};

	try {
		const files = await listMemoryFiles(repoKey);
		const fileIds = new Set(files.map((f) => f.id));

		for (const f of files) {
			let record = await readMemoryFile(repoKey, f.id, f.location);
			let repaired = false;

			// Repair only applies to active memories on disk. Trash is excluded —
			// `writeMemoryFile` always writes into the active `memories/`
			// directory, so repairing a trashed file would silently restore it.
			if (f.location === "memories") {
				const fmEmpty =
					record.frontmatter.scope.files.length === 0 &&
					record.frontmatter.scope.tags.length === 0;
				const probe = parseLegacyScopeTrailer(record.body);
				if (probe.matched) {
					const mergedFiles = fmEmpty
						? probe.scopeFiles
						: record.frontmatter.scope.files;
					const mergedTags = fmEmpty
						? probe.scopeTags
						: record.frontmatter.scope.tags;
					const nextFm = {
						...record.frontmatter,
						scope: { files: mergedFiles, tags: mergedTags },
						version: record.frontmatter.version + 1,
						updatedAt: new Date().toISOString(),
					};
					record = { frontmatter: nextFm, body: probe.strippedBody };
					await writeMemoryFile(repoKey, record);
					repaired = true;
				}
			}

			const hash = bodyHash(record.frontmatter.title, record.body);
			const row = index.getMemory(f.id);
			if (!row) {
				index.upsertMemory(record.frontmatter, {
					bodyHash: hash,
					bodyExcerpt: bodyExcerpt(record.body),
					body: record.body,
				});
				safeAppendAudit(index, {
					memoryId: f.id,
					version: record.frontmatter.version,
					ts: new Date().toISOString(),
					changeType: "reconcile",
					prevBodyHash: null,
					prevBody: null,
					reason: repaired
						? "adopted from disk; legacy scope normalized"
						: "adopted from disk",
					agentId,
				});
				await upsertMemoryVector(
					repoKey,
					f.id,
					record.frontmatter.title,
					record.body,
					hash,
				);
				report.adopted.push(f.id);
				if (repaired) report.legacyRepaired.push(f.id);
			} else if (repaired || row.body_hash !== hash) {
				// Widened condition: repair-only events (canonical body matches
				// the stored hash because we already canonicalized to the same
				// shape on a previous pass) still produce an audit row and a
				// fresh upsert, because `version`/`updatedAt`/scope rows changed.
				index.upsertMemory(record.frontmatter, {
					bodyHash: hash,
					bodyExcerpt: bodyExcerpt(record.body),
					body: record.body,
				});
				safeAppendAudit(index, {
					memoryId: f.id,
					// When repaired, fm.version was already bumped during repair, so
					// the persisted row is at fm.version — audit at the same number.
					// When NOT repaired, preserve the existing (pre-plan) behavior of
					// auditing at fm.version + 1 to avoid an incidental schema change.
					version: repaired
						? record.frontmatter.version
						: record.frontmatter.version + 1,
					ts: new Date().toISOString(),
					changeType: "reconcile",
					prevBodyHash: row.body_hash,
					prevBody: null,
					reason: repaired ? "legacy scope normalized" : "body-hash drift",
					agentId,
				});
				await upsertMemoryVector(
					repoKey,
					f.id,
					record.frontmatter.title,
					record.body,
					hash,
				);
				report.reindexed.push(f.id);
				if (repaired) report.legacyRepaired.push(f.id);
			}
		}

		const allRows = index
			.rawDb()
			.prepare("SELECT id, status FROM memories")
			.all() as { id: string; status: string }[];
		for (const r of allRows) {
			if (r.status === "purged_redacted" || r.status === "trashed") continue;
			if (!fileIds.has(r.id)) {
				const maxV =
					(
						index
							.rawDb()
							.prepare(
								"SELECT MAX(version) AS v FROM memory_audit WHERE memory_id=?",
							)
							.get(r.id) as { v: number | null }
					).v ?? 0;
				index.deleteMemoryRow(r.id);
				safeAppendAudit(index, {
					memoryId: r.id,
					version: maxV + 1,
					ts: new Date().toISOString(),
					changeType: "reconcile",
					prevBodyHash: null,
					prevBody: null,
					reason: "phantom row removed",
					agentId,
				});
				await deleteMemoryVector(repoKey, r.id);
				report.phantomsRemoved.push(r.id);
			}
		}
	} finally {
		index.close();
	}
	return report;
}
