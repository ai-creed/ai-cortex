export type DocInput = {
	path: string;
	title: string;
	body: string;
};

export type FileNode = {
	path: string;
	kind: "file" | "dir";
};

export type ImportEdge = {
	from: string;
	to: string;
};

export type RepoCache = {
	repoPath: string;
	repoKey: string;
	indexedAt: string;
	fingerprint: string;
	files: FileNode[];
	docs: DocInput[];
	imports: ImportEdge[];
};

export type RepoSummaryCache = {
	repoKey: string;
	indexedAt: string;
	fingerprint: string;
	summary: string;
	priorityDocs: string[];
	priorityFiles: string[];
};

export type RehydrateResult = {
	summary: string;
	priorityDocs: string[];
	priorityFiles: string[];
	stale: boolean;
	cacheStatus: "fresh" | "stale" | "missing";
};

export type SuggestResult = {
	path: string;
	reason: string;
};
