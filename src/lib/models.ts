// src/lib/models.ts

export const SCHEMA_VERSION = "3.2";

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

export type SymbolKind =
	| "function"
	| "method"
	| "class"
	| "interface"
	| "type"
	| "struct"
	| "enum"
	| "enum_member"
	| "variable"
	| "property"
	| "namespace"
	| "macro";

export type SymbolNode = {
	qualifiedName: string; // container path joined with '.', never contains '::'
	name: string; // identifier text of the name node
	file: string;
	kind: SymbolKind;
	containerQualifiedName?: string; // enclosing symbol's qualifiedName, absent at module scope
	exported: boolean;
	isDefaultExport: boolean;
	isDeclarationOnly: boolean;
	range: Range; // declaration range
	nameRange: Range; // identifier range, the jump target
};

export type RefKind =
	| "call"
	| "new"
	| "type"
	| "extends"
	| "implements"
	| "import"
	| "export"
	| "member"
	| "jsx"
	| "decorator";

export type RefEdge = {
	file: string;
	name: string;
	kind: RefKind;
	range: Range; // identifier token range
	to?: string; // symbols key, absent when unresolved
	from?: string; // enclosing symbols key, absent at module scope
};

export type ReexportRow = {
	file: string;
	exportedName: string;
	sourceName: string;
	specifier: string;
};

export type NavCapabilities = {
	symbols: true;
	references: true;
	referencesTable: "refs";
	symbolKinds: SymbolKind[];
	referenceKinds: RefKind[];
};

export type BlastHit = {
	qualifiedName: string;
	file: string;
	hop: number;
	exported: boolean;
	range?: Range; // NEW: caller function range (v3.1)
	callSite?: Range; // NEW: edge site reaching the next callee toward the target
};

export type RepoCache = {
	schemaVersion: typeof SCHEMA_VERSION;
	repoKey: string;
	worktreeKey: string;
	worktreePath: string;
	indexedAt: string;
	fingerprint: string;
	dirtyAtIndex?: boolean;
	indexSeq: number; // assigned by the sequence commit; 0 until written
	contentFingerprint: string; // sha1 over sorted (path, contentHash) of files
	packageMeta: PackageMeta;
	entryFiles: string[];
	files: FileNode[];
	docs: DocInput[];
	imports: ImportEdge[];
	calls: CallEdge[];
	functions: FunctionNode[]; // derived from symbols (A2.2)
	symbols: SymbolNode[];
	refs: RefEdge[];
	reexports: ReexportRow[];
};
