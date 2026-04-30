import crypto from "node:crypto";
import { generateMemoryId } from "./id.js";
import { writeMemoryFile, readMemoryFile, purgeMemoryFile } from "./store.js";
import { MemoryIndex, openMemoryIndex } from "./index.js";
import { upsertMemoryVector } from "./embed.js";
import { ensureRegistry, readRegistry, validateRegistration } from "./registry.js";
import type { TypeRegistry } from "./registry.js";
import { bodyExcerpt } from "./markdown.js";
import { memoryRootDir } from "./paths.js";
import type { MemoryFrontmatter, MemoryRecord, MemorySource, MemoryStatus, AuditChangeType } from "./types.js";

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

export async function openLifecycle(repoKey: string, options: OpenLifecycleOptions = {}): Promise<LifecycleHandle> {
	await ensureRegistry(memoryRootDir(repoKey));
	const registry = await readRegistry(memoryRootDir(repoKey));
	const index = openMemoryIndex(repoKey);
	return {
		repoKey,
		agentId: options.agentId ?? null,
		index,
		registry,
		close() { index.close(); },
	};
}

function bodyHash(title: string, body: string): string {
	return crypto.createHash("sha256").update(title).update("\n\n").update(body).digest("hex");
}

async function commit(lc: LifecycleHandle, record: MemoryRecord, audit: { changeType: AuditChangeType; prevBodyHash: string | null; prevBody: string | null; reason: string | null }): Promise<void> {
	const hash = bodyHash(record.frontmatter.title, record.body);
	const excerpt = bodyExcerpt(record.body);

	await writeMemoryFile(lc.repoKey, record);

	const tx = lc.index.rawDb().transaction(() => {
		lc.index.upsertMemory(record.frontmatter, { bodyHash: hash, bodyExcerpt: excerpt, body: record.body });
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

	await upsertMemoryVector(lc.repoKey, record.frontmatter.id, record.frontmatter.title, record.body, hash);
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
	throw new Error(`failed to generate a unique memory id for title=${JSON.stringify(title)} after ${ID_COLLISION_MAX_ATTEMPTS} attempts`);
}

export async function createMemory(lc: LifecycleHandle, input: CreateMemoryInput): Promise<string> {
	const validation = validateRegistration(lc.registry, { type: input.type, typeFields: input.typeFields });
	if (!validation.ok) throw new Error(`validation failed: ${(validation as { ok: false; errors: string[] }).errors.join("; ")}`);

	const id = generateUniqueMemoryId(lc, input.title);
	const now = new Date().toISOString();
	const isExtracted = input.source === "extracted";
	const status: MemoryStatus = isExtracted ? "candidate" : "active";
	const confidence = input.confidence ?? (isExtracted ? 0.5 : 1.0);

	const fm: MemoryFrontmatter = {
		id, type: input.type, status, title: input.title, version: 1,
		createdAt: now, updatedAt: now,
		source: input.source, confidence,
		pinned: input.pinned ?? false,
		scope: { files: [...input.scope.files], tags: [...input.scope.tags] },
		provenance: [], supersedes: [], mergedInto: null,
		deprecationReason: null, promotedFrom: [],
		typeFields: input.typeFields,
	};

	await commit(lc, { frontmatter: fm, body: input.body }, {
		changeType: "create", prevBodyHash: null, prevBody: null, reason: null,
	});

	return id;
}

export type UpdateMemoryInput = {
	body?: string;
	title?: string;
	pinned?: boolean;
	typeFields?: Record<string, unknown>;
	reason?: string;
};

async function loadCurrent(lc: LifecycleHandle, id: string): Promise<MemoryRecord> {
	const row = lc.index.getMemory(id);
	if (!row) throw new Error(`memory not found: ${id}`);
	const location = row.status === "trashed" ? "trash" : "memories";
	return readMemoryFile(lc.repoKey, id, location);
}

function shouldPreserveBody(lc: LifecycleHandle, type: string): boolean {
	return lc.registry.types[type]?.auditPreserveBody === true;
}

export async function updateMemory(lc: LifecycleHandle, id: string, patch: UpdateMemoryInput): Promise<void> {
	const current = await loadCurrent(lc, id);
	const prevHash = (lc.index.getMemory(id)!).body_hash;
	const prevBody = shouldPreserveBody(lc, current.frontmatter.type) ? current.body : null;

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

export async function updateScope(lc: LifecycleHandle, id: string, scope: { files: string[]; tags: string[] }): Promise<void> {
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
