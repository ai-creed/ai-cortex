import crypto from "node:crypto";
import fsSync from "node:fs/promises";
import { generateMemoryId } from "./id.js";
import {
	writeMemoryFile,
	readMemoryFile,
	purgeMemoryFile,
	moveToTrash,
	restoreFromTrash,
} from "./store.js";
import { MemoryIndex, openMemoryIndex } from "./index.js";
import { upsertMemoryVector } from "./embed.js";
import {
	ensureRegistry,
	readRegistry,
	validateRegistration,
} from "./registry.js";
import type { TypeRegistry } from "./registry.js";
import { bodyExcerpt, serializeMemoryMarkdown } from "./markdown.js";
import { memoryRootDir, memoryFilePath } from "./paths.js";
import { loadMemoryConfig } from "./config.js";
import type {
	MemoryFrontmatter,
	MemoryRecord,
	MemorySource,
	MemoryStatus,
	AuditChangeType,
	MemoryEdgeType,
	ProvenanceEntry,
} from "./types.js";

export type LifecycleHandle = {
	repoKey: string;
	agentId: string | null;
	index: MemoryIndex;
	registry: TypeRegistry;
	close: () => void;
};

export type OpenLifecycleOptions = {
	agentId?: string;
};

export async function openLifecycle(
	repoKey: string,
	options: OpenLifecycleOptions = {},
): Promise<LifecycleHandle> {
	await ensureRegistry(memoryRootDir(repoKey));
	const registry = await readRegistry(memoryRootDir(repoKey));
	const index = openMemoryIndex(repoKey);
	return {
		repoKey,
		agentId: options.agentId ?? null,
		index,
		registry,
		close() {
			index.close();
		},
	};
}

function bodyHash(title: string, body: string): string {
	return crypto
		.createHash("sha256")
		.update(title)
		.update("\n\n")
		.update(body)
		.digest("hex");
}

async function commit(
	lc: LifecycleHandle,
	record: MemoryRecord,
	audit: {
		changeType: AuditChangeType;
		prevBodyHash: string | null;
		prevBody: string | null;
		reason: string | null;
	},
): Promise<void> {
	const hash = bodyHash(record.frontmatter.title, record.body);
	const excerpt = bodyExcerpt(record.body);

	await writeMemoryFile(lc.repoKey, record);

	const tx = lc.index.rawDb().transaction(() => {
		lc.index.upsertMemory(record.frontmatter, {
			bodyHash: hash,
			bodyExcerpt: excerpt,
			body: record.body,
		});
		lc.index.appendAudit({
			memoryId: record.frontmatter.id,
			version: record.frontmatter.version,
			ts: record.frontmatter.updatedAt,
			changeType: audit.changeType,
			prevBodyHash: audit.prevBodyHash,
			prevBody: audit.prevBody,
			reason: audit.reason,
			agentId: lc.agentId,
		});
	});
	tx();

	await upsertMemoryVector(
		lc.repoKey,
		record.frontmatter.id,
		record.frontmatter.title,
		record.body,
		hash,
	);
}

export type CreateMemoryInput = {
	type: string;
	title: string;
	body: string;
	scope: { files: string[]; tags: string[] };
	source: MemorySource;
	confidence?: number;
	pinned?: boolean;
	typeFields?: Record<string, unknown>;
};

const ID_COLLISION_MAX_ATTEMPTS = 8;

function generateUniqueMemoryId(lc: LifecycleHandle, title: string): string {
	for (let attempt = 0; attempt < ID_COLLISION_MAX_ATTEMPTS; attempt++) {
		const candidate = generateMemoryId(title);
		if (!lc.index.getMemory(candidate)) return candidate;
	}
	throw new Error(
		`failed to generate a unique memory id for title=${JSON.stringify(title)} after ${ID_COLLISION_MAX_ATTEMPTS} attempts`,
	);
}

export async function createMemory(
	lc: LifecycleHandle,
	input: CreateMemoryInput,
): Promise<string> {
	const validation = validateRegistration(lc.registry, {
		type: input.type,
		typeFields: input.typeFields,
	});
	if (!validation.ok)
		throw new Error(
			`validation failed: ${(validation as { ok: false; errors: string[] }).errors.join("; ")}`,
		);

	const id = generateUniqueMemoryId(lc, input.title);
	const now = new Date().toISOString();
	const isExtracted = input.source === "extracted";
	const status: MemoryStatus = isExtracted ? "candidate" : "active";
	const confidence = input.confidence ?? (isExtracted ? 0.5 : 1.0);

	const fm: MemoryFrontmatter = {
		id,
		type: input.type,
		status,
		title: input.title,
		version: 1,
		createdAt: now,
		updatedAt: now,
		source: input.source,
		confidence,
		pinned: input.pinned ?? false,
		scope: { files: [...input.scope.files], tags: [...input.scope.tags] },
		provenance: [],
		supersedes: [],
		mergedInto: null,
		deprecationReason: null,
		promotedFrom: [],
		rewrittenAt: null,
		typeFields: input.typeFields,
	};

	await commit(
		lc,
		{ frontmatter: fm, body: input.body },
		{
			changeType: "create",
			prevBodyHash: null,
			prevBody: null,
			reason: null,
		},
	);

	return id;
}

export type UpdateMemoryInput = {
	body?: string;
	title?: string;
	pinned?: boolean;
	typeFields?: Record<string, unknown>;
	reason?: string;
};

async function loadCurrent(
	lc: LifecycleHandle,
	id: string,
): Promise<MemoryRecord> {
	const row = lc.index.getMemory(id);
	if (!row) throw new Error(`memory not found: ${id}`);
	const location = row.status === "trashed" ? "trash" : "memories";
	return readMemoryFile(lc.repoKey, id, location);
}

function shouldPreserveBody(lc: LifecycleHandle, type: string): boolean {
	return lc.registry.types[type]?.auditPreserveBody === true;
}

export async function updateMemory(
	lc: LifecycleHandle,
	id: string,
	patch: UpdateMemoryInput,
): Promise<void> {
	const current = await loadCurrent(lc, id);
	const prevHash = lc.index.getMemory(id)!.body_hash;
	const prevBody = shouldPreserveBody(lc, current.frontmatter.type)
		? current.body
		: null;

	const next: MemoryRecord = {
		frontmatter: {
			...current.frontmatter,
			version: current.frontmatter.version + 1,
			updatedAt: new Date().toISOString(),
			title: patch.title ?? current.frontmatter.title,
			pinned: patch.pinned ?? current.frontmatter.pinned,
			typeFields: patch.typeFields ?? current.frontmatter.typeFields,
		},
		body: patch.body ?? current.body,
	};

	await commit(lc, next, {
		changeType: "update",
		prevBodyHash: prevHash,
		prevBody,
		reason: patch.reason ?? null,
	});
}

export async function updateScope(
	lc: LifecycleHandle,
	id: string,
	scope: { files: string[]; tags: string[] },
): Promise<void> {
	const current = await loadCurrent(lc, id);
	const next: MemoryRecord = {
		frontmatter: {
			...current.frontmatter,
			version: current.frontmatter.version + 1,
			updatedAt: new Date().toISOString(),
			scope: { files: [...scope.files], tags: [...scope.tags] },
		},
		body: current.body,
	};
	await commit(lc, next, {
		changeType: "scope_change",
		prevBodyHash: lc.index.getMemory(id)!.body_hash,
		prevBody: null,
		reason: null,
	});
}

export async function deprecateMemory(
	lc: LifecycleHandle,
	id: string,
	reason: string,
): Promise<void> {
	const current = await loadCurrent(lc, id);
	if (
		current.frontmatter.status !== "active" &&
		current.frontmatter.status !== "candidate"
	) {
		throw new Error(
			`cannot deprecate from status ${current.frontmatter.status}`,
		);
	}
	const next: MemoryRecord = {
		frontmatter: {
			...current.frontmatter,
			version: current.frontmatter.version + 1,
			updatedAt: new Date().toISOString(),
			status: "deprecated",
			deprecationReason: reason,
		},
		body: current.body,
	};
	await commit(lc, next, {
		changeType: "deprecate",
		prevBodyHash: lc.index.getMemory(id)!.body_hash,
		prevBody: null,
		reason,
	});
}

export async function restoreMemory(
	lc: LifecycleHandle,
	id: string,
): Promise<void> {
	const current = await loadCurrent(lc, id);
	if (current.frontmatter.status !== "deprecated") {
		throw new Error(
			`restoreMemory only from deprecated, not ${current.frontmatter.status}`,
		);
	}
	const next: MemoryRecord = {
		frontmatter: {
			...current.frontmatter,
			version: current.frontmatter.version + 1,
			updatedAt: new Date().toISOString(),
			status: "active",
			deprecationReason: null,
		},
		body: current.body,
	};
	await commit(lc, next, {
		changeType: "restore",
		prevBodyHash: lc.index.getMemory(id)!.body_hash,
		prevBody: null,
		reason: null,
	});
}

export async function mergeMemories(
	lc: LifecycleHandle,
	srcId: string,
	dstId: string,
	mergedBody: string,
): Promise<void> {
	if (srcId === dstId) throw new Error("cannot merge a memory into itself");
	const src = await loadCurrent(lc, srcId);
	const dst = await loadCurrent(lc, dstId);
	if (
		src.frontmatter.status !== "active" &&
		src.frontmatter.status !== "candidate"
	) {
		throw new Error(
			`merge source must be active/candidate, got ${src.frontmatter.status}`,
		);
	}
	if (
		dst.frontmatter.status !== "active" &&
		dst.frontmatter.status !== "candidate"
	) {
		throw new Error(
			`merge destination must be active/candidate, got ${dst.frontmatter.status}`,
		);
	}

	const nextSrc: MemoryRecord = {
		frontmatter: {
			...src.frontmatter,
			version: src.frontmatter.version + 1,
			updatedAt: new Date().toISOString(),
			status: "merged_into",
			mergedInto: dstId,
		},
		body: src.body,
	};
	await commit(lc, nextSrc, {
		changeType: "merge",
		prevBodyHash: lc.index.getMemory(srcId)!.body_hash,
		prevBody: null,
		reason: `merged into ${dstId}`,
	});

	const nextDst: MemoryRecord = {
		frontmatter: {
			...dst.frontmatter,
			version: dst.frontmatter.version + 1,
			updatedAt: new Date().toISOString(),
			supersedes: [...dst.frontmatter.supersedes, srcId],
		},
		body: mergedBody,
	};
	await commit(lc, nextDst, {
		changeType: "merge",
		prevBodyHash: lc.index.getMemory(dstId)!.body_hash,
		prevBody: shouldPreserveBody(lc, dst.frontmatter.type) ? dst.body : null,
		reason: `merged from ${srcId}`,
	});
}

export async function trashMemory(
	lc: LifecycleHandle,
	id: string,
	reason: string,
): Promise<void> {
	const current = await loadCurrent(lc, id);
	if (current.frontmatter.status === "trashed") {
		throw new Error("memory is already trashed");
	}
	if (current.frontmatter.status === "purged_redacted") {
		throw new Error("cannot trash a purged_redacted memory");
	}

	await moveToTrash(lc.repoKey, id);

	const prevHash = lc.index.getMemory(id)!.body_hash;
	const newVersion = current.frontmatter.version + 1;
	const now = new Date().toISOString();

	const tx = lc.index.rawDb().transaction(() => {
		lc.index
			.rawDb()
			.prepare(
				"UPDATE memories SET status='trashed', version=?, updated_at=? WHERE id=?",
			)
			.run(newVersion, now, id);
		lc.index.appendAudit({
			memoryId: id,
			version: newVersion,
			ts: now,
			changeType: "trash",
			prevBodyHash: prevHash,
			prevBody: null,
			reason,
			agentId: lc.agentId,
		});
	});
	tx();

	// Rewrite .md in trash/ with updated frontmatter
	const updated: MemoryRecord = {
		frontmatter: {
			...current.frontmatter,
			status: "trashed",
			version: newVersion,
			updatedAt: now,
		},
		body: current.body,
	};
	const finalPath = memoryFilePath(lc.repoKey, id, "trash");
	const tmpPath = `${finalPath}.tmp`;
	const fh = await fsSync.open(tmpPath, "w");
	try {
		await fh.writeFile(serializeMemoryMarkdown(updated));
		await fh.sync();
	} finally {
		await fh.close();
	}
	await fsSync.rename(tmpPath, finalPath);
}

export async function untrashMemory(
	lc: LifecycleHandle,
	id: string,
): Promise<void> {
	const current = await loadCurrent(lc, id);
	if (current.frontmatter.status !== "trashed") {
		throw new Error(
			`untrashMemory only from trashed, not ${current.frontmatter.status}`,
		);
	}

	await restoreFromTrash(lc.repoKey, id);

	const newVersion = current.frontmatter.version + 1;
	const now = new Date().toISOString();

	const tx = lc.index.rawDb().transaction(() => {
		lc.index
			.rawDb()
			.prepare(
				"UPDATE memories SET status='active', version=?, updated_at=? WHERE id=?",
			)
			.run(newVersion, now, id);
		lc.index.appendAudit({
			memoryId: id,
			version: newVersion,
			ts: now,
			changeType: "untrash",
			prevBodyHash: lc.index.getMemory(id)!.body_hash,
			prevBody: null,
			reason: null,
			agentId: lc.agentId,
		});
	});
	tx();

	const next: MemoryRecord = {
		frontmatter: {
			...current.frontmatter,
			status: "active",
			version: newVersion,
			updatedAt: now,
		},
		body: current.body,
	};
	await writeMemoryFile(lc.repoKey, next);
}

export type PurgeOptions = { redact?: boolean };

export async function purgeMemory(
	lc: LifecycleHandle,
	id: string,
	reason: string,
	options: PurgeOptions = {},
): Promise<void> {
	const current = await loadCurrent(lc, id);
	const location =
		current.frontmatter.status === "trashed" ? "trash" : "memories";
	const prevHash = lc.index.getMemory(id)!.body_hash;

	if (!options.redact) {
		const tx = lc.index.rawDb().transaction(() => {
			lc.index.appendAudit({
				memoryId: id,
				version: current.frontmatter.version + 1,
				ts: new Date().toISOString(),
				changeType: "purge",
				prevBodyHash: prevHash,
				prevBody: null,
				reason,
				agentId: lc.agentId,
			});
			lc.index
				.rawDb()
				.prepare("DELETE FROM memory_fts WHERE memory_id=?")
				.run(id);
			lc.index
				.rawDb()
				.prepare(
					"UPDATE memories SET status='trashed', body_excerpt='<purged>' WHERE id=?",
				)
				.run(id);
		});
		tx();
	} else {
		const tx = lc.index.rawDb().transaction(() => {
			lc.index
				.rawDb()
				.prepare(
					"UPDATE memory_audit SET prev_body=NULL, reason='<redacted>' WHERE memory_id=?",
				)
				.run(id);
			lc.index.appendAudit({
				memoryId: id,
				version: current.frontmatter.version + 1,
				ts: new Date().toISOString(),
				changeType: "purge_redact",
				prevBodyHash: null,
				prevBody: null,
				reason: "<redacted>",
				agentId: lc.agentId,
			});
			lc.index
				.rawDb()
				.prepare(
					"UPDATE memories SET status='purged_redacted', title='<redacted>', body_excerpt='<redacted>' WHERE id=?",
				)
				.run(id);
			lc.index
				.rawDb()
				.prepare("DELETE FROM memory_fts WHERE memory_id=?")
				.run(id);
		});
		tx();
	}

	await purgeMemoryFile(lc.repoKey, id, location);
	const { deleteMemoryVector } = await import("./embed.js");
	await deleteMemoryVector(lc.repoKey, id);
}

const REL_TYPES: readonly MemoryEdgeType[] = [
	"supports",
	"contradicts",
	"refines",
	"depends_on",
] as const;

function nextAuditVersion(lc: LifecycleHandle, id: string): number {
	const row = lc.index
		.rawDb()
		.prepare("SELECT MAX(version) AS v FROM memory_audit WHERE memory_id=?")
		.get(id) as { v: number | null };
	return (row.v ?? 0) + 1;
}

export async function linkMemories(
	lc: LifecycleHandle,
	srcId: string,
	dstId: string,
	relType: MemoryEdgeType,
): Promise<void> {
	if (srcId === dstId)
		throw new Error("cannot link a memory to itself (self-link)");
	if (!REL_TYPES.includes(relType))
		throw new Error(`unknown rel type: ${relType}`);
	if (!lc.index.getMemory(srcId))
		throw new Error(`source memory not found: ${srcId}`);
	if (!lc.index.getMemory(dstId))
		throw new Error(`destination memory not found: ${dstId}`);

	const tx = lc.index.rawDb().transaction(() => {
		lc.index.addLink({
			srcId,
			dstId,
			relType,
			createdAt: new Date().toISOString(),
		});
		lc.index.appendAudit({
			memoryId: srcId,
			version: nextAuditVersion(lc, srcId),
			ts: new Date().toISOString(),
			changeType: "link_add",
			prevBodyHash: null,
			prevBody: null,
			reason: `${relType} → ${dstId}`,
			agentId: lc.agentId,
		});
	});
	tx();
}

export async function unlinkMemories(
	lc: LifecycleHandle,
	srcId: string,
	dstId: string,
	relType: MemoryEdgeType,
): Promise<void> {
	if (!REL_TYPES.includes(relType))
		throw new Error(`unknown rel type: ${relType}`);
	const tx = lc.index.rawDb().transaction(() => {
		lc.index.removeLink(srcId, dstId, relType);
		lc.index.appendAudit({
			memoryId: srcId,
			version: nextAuditVersion(lc, srcId),
			ts: new Date().toISOString(),
			changeType: "link_remove",
			prevBodyHash: null,
			prevBody: null,
			reason: `${relType} → ${dstId}`,
			agentId: lc.agentId,
		});
	});
	tx();
}

export type PinOptions = { force?: boolean };

export async function pinMemory(
	lc: LifecycleHandle,
	id: string,
	options: PinOptions = {},
): Promise<void> {
	const current = await loadCurrent(lc, id);
	if (!options.force) {
		const cfg = await loadMemoryConfig(lc.repoKey);
		const count = lc.index
			.rawDb()
			.prepare("SELECT COUNT(*) AS c FROM memories WHERE pinned=1")
			.get() as { c: number };
		if (count.c >= cfg.injection.pinnedHardCap) {
			throw new Error(
				`pinned hard cap reached (${cfg.injection.pinnedHardCap}); pass { force: true } to override`,
			);
		}
	}
	const next: MemoryRecord = {
		frontmatter: {
			...current.frontmatter,
			version: current.frontmatter.version + 1,
			updatedAt: new Date().toISOString(),
			pinned: true,
		},
		body: current.body,
	};
	await commit(lc, next, {
		changeType: "pin",
		prevBodyHash: lc.index.getMemory(id)!.body_hash,
		prevBody: null,
		reason: null,
	});
}

export async function unpinMemory(
	lc: LifecycleHandle,
	id: string,
): Promise<void> {
	const current = await loadCurrent(lc, id);
	const next: MemoryRecord = {
		frontmatter: {
			...current.frontmatter,
			version: current.frontmatter.version + 1,
			updatedAt: new Date().toISOString(),
			pinned: false,
		},
		body: current.body,
	};
	await commit(lc, next, {
		changeType: "unpin",
		prevBodyHash: lc.index.getMemory(id)!.body_hash,
		prevBody: null,
		reason: null,
	});
}

export async function confirmMemory(
	lc: LifecycleHandle,
	id: string,
): Promise<void> {
	const current = await loadCurrent(lc, id);
	if (current.frontmatter.status !== "candidate") {
		throw new Error(
			`confirmMemory only from candidate, not ${current.frontmatter.status}`,
		);
	}
	const next: MemoryRecord = {
		frontmatter: {
			...current.frontmatter,
			version: current.frontmatter.version + 1,
			updatedAt: new Date().toISOString(),
			status: "active",
			confidence: 1.0,
		},
		body: current.body,
	};
	await commit(lc, next, {
		changeType: "promote",
		prevBodyHash: lc.index.getMemory(id)!.body_hash,
		prevBody: null,
		reason: "explicit confirm",
	});
}

export async function addEvidence(
	lc: LifecycleHandle,
	id: string,
	entry: ProvenanceEntry,
): Promise<void> {
	const current = await loadCurrent(lc, id);
	const next: MemoryRecord = {
		frontmatter: {
			...current.frontmatter,
			version: current.frontmatter.version + 1,
			updatedAt: new Date().toISOString(),
			provenance: [...current.frontmatter.provenance, entry],
		},
		body: current.body,
	};
	await commit(lc, next, {
		changeType: "update",
		prevBodyHash: lc.index.getMemory(id)!.body_hash,
		prevBody: null,
		reason: `add_evidence ${entry.sessionId}#${entry.turn}`,
	});
}

export async function bumpConfidence(
	lc: LifecycleHandle,
	id: string,
	delta: number,
	reason: string,
): Promise<number> {
	const current = await loadCurrent(lc, id);
	const next = Math.min(
		0.95,
		Math.max(0, current.frontmatter.confidence + delta),
	);
	if (next === current.frontmatter.confidence)
		return current.frontmatter.confidence;
	const updated: MemoryRecord = {
		frontmatter: {
			...current.frontmatter,
			version: current.frontmatter.version + 1,
			updatedAt: new Date().toISOString(),
			confidence: next,
		},
		body: current.body,
	};
	await commit(lc, updated, {
		changeType: "update",
		prevBodyHash: lc.index.getMemory(id)!.body_hash,
		prevBody: null,
		reason,
	});
	return next;
}

export function bumpReExtract(lc: LifecycleHandle, id: string): void {
	lc.index.bumpReExtract(id);
}

export type RewriteMemoryFields = {
	title: string;
	body: string;
	scopeFiles: string[];
	scopeTags: string[];
	type?: string;
	typeFields?: Record<string, unknown>;
};

export async function rewriteMemory(
	lc: LifecycleHandle,
	id: string,
	fields: RewriteMemoryFields,
): Promise<void> {
	const memRow = lc.index.getMemory(id);
	if (!memRow) throw new Error(`memory not found: ${id}`);

	const status = memRow.status as MemoryStatus;
	if (
		status === "merged_into" ||
		status === "trashed" ||
		status === "purged_redacted"
	) {
		throw new Error(`cannot rewrite a ${status} memory`);
	}

	const current = await loadCurrent(lc, id);

	// Whenever the caller explicitly touches `type` or `typeFields`, validate
	// the resulting (type, typeFields) pair against the registry — same contract
	// createMemory enforces. This catches:
	//   - changing type to one with stricter requirements without supplying the
	//     matching fields,
	//   - setting an invalid value on a typeFields field of the existing type
	//     (e.g., severity: "bogus" on a gotcha) even when type doesn't change.
	const nextType = fields.type ?? current.frontmatter.type;
	const nextTypeFields = fields.typeFields ?? current.frontmatter.typeFields;
	if (fields.type !== undefined || fields.typeFields !== undefined) {
		const validation = validateRegistration(lc.registry, {
			type: nextType,
			typeFields: nextTypeFields,
		});
		if (!validation.ok) {
			throw new Error(
				`rewriteMemory: ${validation.errors.join("; ")}`,
			);
		}
	}

	const now = new Date().toISOString();
	const promotedFromCandidate = status === "candidate";
	const nextStatus = promotedFromCandidate ? "active" : status;
	const nextConfidence = promotedFromCandidate ? 1.0 : current.frontmatter.confidence;

	const updated: MemoryRecord = {
		frontmatter: {
			...current.frontmatter,
			version: current.frontmatter.version + 1,
			updatedAt: now,
			rewrittenAt: now,
			status: nextStatus,
			title: fields.title,
			scope: { files: [...fields.scopeFiles], tags: [...fields.scopeTags] },
			confidence: nextConfidence,
			type: nextType,
			...(fields.typeFields !== undefined
				? { typeFields: fields.typeFields }
				: {}),
		},
		body: fields.body,
	};

	const prevBody = shouldPreserveBody(lc, current.frontmatter.type)
		? current.body
		: null;

	await commit(lc, updated, {
		changeType: "update",
		prevBodyHash: memRow.body_hash,
		prevBody,
		reason: "rewrite",
	});
}

export const GLOBAL_REPO_KEY = "global";

export async function openGlobalLifecycle(
	opts: { agentId?: string } = {},
): Promise<LifecycleHandle> {
	return openLifecycle(GLOBAL_REPO_KEY, opts);
}

export async function promoteToGlobal(
	lc: LifecycleHandle,
	id: string,
): Promise<string> {
	const current = await loadCurrent(lc, id);
	if (current.frontmatter.status === "merged_into") {
		throw new Error(
			`memory ${id} is already merged_into ${current.frontmatter.mergedInto}`,
		);
	}
	if (
		current.frontmatter.status === "trashed" ||
		current.frontmatter.status === "purged_redacted"
	) {
		throw new Error(`cannot promote a ${current.frontmatter.status} memory`);
	}

	const globalLc = await openGlobalLifecycle({
		agentId: lc.agentId ?? "promote",
	});
	try {
		const now = new Date().toISOString();
		const globalId = generateUniqueMemoryId(globalLc, current.frontmatter.title);
		const globalFm: MemoryFrontmatter = {
			...current.frontmatter,
			id: globalId,
			version: 1,
			createdAt: now,
			updatedAt: now,
			promotedFrom: [{ repoKey: lc.repoKey, memoryId: id }],
			supersedes: [],
			mergedInto: null,
			provenance: [...current.frontmatter.provenance],
			rewrittenAt: null,
		};
		await commit(
			globalLc,
			{ frontmatter: globalFm, body: current.body },
			{
				changeType: "create",
				prevBodyHash: null,
				prevBody: null,
				reason: `promoted from ${lc.repoKey}:${id}`,
			},
		);

		// Mark original as merged_into the global copy
		const updatedOriginal: MemoryRecord = {
			frontmatter: {
				...current.frontmatter,
				version: current.frontmatter.version + 1,
				updatedAt: now,
				status: "merged_into",
				mergedInto: globalId,
			},
			body: current.body,
		};
		await commit(lc, updatedOriginal, {
			changeType: "merge",
			prevBodyHash: lc.index.getMemory(id)!.body_hash,
			prevBody: null,
			reason: `promoted to global:${globalId}`,
		});

		return globalId;
	} finally {
		globalLc.close();
	}
}
