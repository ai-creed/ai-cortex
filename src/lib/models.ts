// src/lib/models.ts

export const SCHEMA_VERSION = "3.1";

export class RepoIdentityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RepoIdentityError";
	}
}

export class IndexError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IndexError";
	}
}

export class ModelLoadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelLoadError";
	}
}

export class VectorIndexCorruptError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VectorIndexCorruptError";
	}
}

export class EmbeddingInferenceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EmbeddingInferenceError";
	}
}

export type RepoIdentity = {
	repoKey: string;
	worktreeKey: string;
	gitCommonDir: string;
	worktreePath: string;
};

export type PackageMeta = {
	name: string;
	version: string;
	main?: string;
	module?: string;
	framework: "electron" | "next" | "vite" | "node" | null;
};

export type FileNode = {
	path: string;
	kind: "file" | "dir";
	contentHash?: string;
};

export type ImportEdge = {
	from: string;
	to: string;
};

export type DocInput = {
	path: string;
	title: string;
	body: string;
};

export type Position = {
	line: number; // 1-indexed
	column: number; // 1-indexed
};

export type Range = Position & {
	endLine: number; // 1-indexed, inclusive
	endColumn: number; // 1-indexed, inclusive
};

export type CallEdge = {
	from: string;
	to: string;
	kind: "call" | "new" | "method";
	site?: Range; // NEW: callsite location in `from`'s file
};

export type FunctionNode = {
	qualifiedName: string;
	file: string;
	exported: boolean;
	isDefaultExport: boolean;
	line: number; // unchanged: start line, 1-indexed
	column?: number; // NEW: start column, 1-indexed
	endLine?: number; // NEW: end line, 1-indexed inclusive
	endColumn?: number; // NEW: end column, 1-indexed inclusive
	isDeclarationOnly?: boolean;
	id?: string; // RESERVED for future rename-stable symbol ID.
	// Writers MUST NOT emit at v3.1. Readers MUST tolerate present or absent.
};

export type BlastHit = {
	qualifiedName: string;
	file: string;
	hop: number;
	exported: boolean;
};

export type RepoCache = {
	schemaVersion: typeof SCHEMA_VERSION;
	repoKey: string;
	worktreeKey: string;
	worktreePath: string;
	indexedAt: string;
	fingerprint: string;
	dirtyAtIndex?: boolean;
	packageMeta: PackageMeta;
	entryFiles: string[];
	files: FileNode[];
	docs: DocInput[];
	imports: ImportEdge[];
	calls: CallEdge[];
	functions: FunctionNode[];
};
