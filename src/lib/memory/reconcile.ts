import crypto from "node:crypto";
import { openMemoryIndex } from "./index.js";
import type { MemoryIndex } from "./index.js";
import { listMemoryFiles, readMemoryFile } from "./store.js";
import { upsertMemoryVector, deleteMemoryVector } from "./embed.js";
import { bodyExcerpt } from "./markdown.js";
import type { AuditRow } from "./types.js";

export type ReconcileReport = {
	reindexed: string[];
	adopted: string[];
	phantomsRemoved: string[];
};

function safeAppendAudit(
	index: MemoryIndex,
	row: AuditRow,
): void {
	try {
		index.appendAudit(row);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (
			!msg.includes("UNIQUE constraint failed: memory_audit.memory_id, memory_audit.version")
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
	};

	try {
		const files = await listMemoryFiles(repoKey);
		const fileIds = new Set(files.map((f) => f.id));

		for (const f of files) {
			const record = await readMemoryFile(repoKey, f.id, f.location);
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
					reason: "adopted from disk",
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
			} else if (row.body_hash !== hash) {
				index.upsertMemory(record.frontmatter, {
					bodyHash: hash,
					bodyExcerpt: bodyExcerpt(record.body),
					body: record.body,
				});
				safeAppendAudit(index, {
					memoryId: f.id,
					version: record.frontmatter.version + 1,
					ts: new Date().toISOString(),
					changeType: "reconcile",
					prevBodyHash: row.body_hash,
					prevBody: null,
					reason: "body-hash drift",
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
