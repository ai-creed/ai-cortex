// src/lib/index.ts
export { indexRepo, getCachedIndex } from "./indexer.js";
export { rehydrateRepo } from "./rehydrate.js";
export type { RehydrateOptions, RehydrateResult } from "./rehydrate.js";
export { RepoIdentityError, IndexError } from "./models.js";
export type {
	RepoCache,
	RepoIdentity,
	PackageMeta,
	FileNode,
	ImportEdge,
	DocInput,
} from "./models.js";
