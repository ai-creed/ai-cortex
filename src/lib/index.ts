// src/lib/index.ts
export { indexRepo, getCachedIndex } from "./indexer.js";
export { rehydrateRepo } from "./rehydrate.js";
export type { RehydrateOptions, RehydrateResult } from "./rehydrate.js";
export { suggestRepo } from "./suggest.js";
export type {
	SuggestOptions,
	SuggestItem,
	DeepSuggestItem,
	SuggestResult,
	FastSuggestResult,
	DeepSuggestResult,
} from "./suggest.js";
export { RepoIdentityError, IndexError } from "./models.js";
export type {
	RepoCache,
	RepoIdentity,
	PackageMeta,
	FileNode,
	ImportEdge,
	DocInput,
	CallEdge,
	FunctionNode,
	BlastHit,
} from "./models.js";
export { queryBlastRadius } from "./blast-radius.js";
export type { BlastRadiusResult, BlastTier } from "./blast-radius.js";
export { extractCallGraph } from "./call-graph.js";
export type { LangAdapter, FileExtractionResult, RawCallSite, ImportBinding } from "./lang-adapter.js";
