// src/lib/memory/types.ts

export const MEMORY_SCHEMA_VERSION = 1;

export type MemoryStatus =
	| "active"
	| "candidate"
	| "deprecated"
	| "merged_into"
	| "trashed"
	| "stale_reference"
	| "purged_redacted";

export type MemorySource = "explicit" | "extracted";

export type MemoryEdgeType =
	| "supports"
	| "contradicts"
	| "refines"
	| "depends_on";

export type ProvenanceKind =
	| "user_correction"
	| "user_prompt"
	| "tool_call"
	| "summary";

export type ProvenanceEntry = {
	sessionId: string;
	turn: number;
	kind: ProvenanceKind;
	excerpt?: string;
};

export type MemoryScope = {
	files: string[];
	tags: string[];
};

export type PromotedFromEntry = {
	repoKey: string;
	memoryId: string;
};

export type MemoryFrontmatter = {
	id: string;
	type: string;
	status: MemoryStatus;
	title: string;
	version: number;
	createdAt: string;
	updatedAt: string;
	source: MemorySource;
	confidence: number;
	pinned: boolean;
	scope: MemoryScope;
	provenance: ProvenanceEntry[];
	supersedes: string[];
	mergedInto: string | null;
	deprecationReason: string | null;
	promotedFrom: PromotedFromEntry[];
	typeFields?: Record<string, unknown>;
};

export type MemoryRecord = {
	frontmatter: MemoryFrontmatter;
	body: string;
};

export type MemoryEdge = {
	srcId: string;
	dstId: string;
	relType: MemoryEdgeType;
	createdAt: string;
};

export type AuditChangeType =
	| "create"
	| "update"
	| "promote"
	| "deprecate"
	| "restore"
	| "merge"
	| "trash"
	| "untrash"
	| "purge"
	| "purge_redact"
	| "scope_change"
	| "link_add"
	| "link_remove"
	| "pin"
	| "unpin"
	| "reconcile";

export type AuditRow = {
	memoryId: string;
	version: number;
	ts: string;
	changeType: AuditChangeType;
	prevBodyHash: string | null;
	prevBody: string | null;
	reason: string | null;
	agentId: string | null;
};
