// src/lib/models.ts

export const SCHEMA_VERSION = "1";

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

export type RepoCache = {
	schemaVersion: typeof SCHEMA_VERSION;
	repoKey: string;
	worktreeKey: string;
	worktreePath: string;
	indexedAt: string;
	fingerprint: string;
	packageMeta: PackageMeta;
	entryFiles: string[];
	files: FileNode[];
	docs: DocInput[];
	imports: ImportEdge[];
};
