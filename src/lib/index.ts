// src/lib/index.ts
export { indexRepo, getCachedIndex } from "./indexer.js";
export { rehydrateRepo } from "./rehydrate.js";
export type { RehydrateOptions, RehydrateResult } from "./rehydrate.js";
export { suggestRepo } from "./suggest.js";
export type {
	SuggestOptions,
	SuggestItem,
	SuggestResult,
} from "./suggest.js";
export { RepoIdentityError, IndexError } from "./models.js";
export type {
	RepoCache,
	RepoIdentity,
	PackageMeta,
	FileNode,
	ImportEdge,
	DocInput,
} from "./models.js";
