// src/lib/models.ts

export const SCHEMA_VERSION = "3";

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

export type CallEdge = {
	from: string;
	to: string;
	kind: "call" | "new" | "method";
};

export type FunctionNode = {
	qualifiedName: string;
	file: string;
	exported: boolean;
	isDefaultExport: boolean;
	line: number;
	isDeclarationOnly?: boolean;
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
