// src/lib/library/mcp-schemas.ts
import { z } from "zod";

// inputSchema objects are passed to server.registerTool as raw zod-field maps.
export const LibrarySearchInput = {
	query: z.string().min(1),
	worktreePath: z.string().optional(),
	sources: z.array(z.string()).optional(),
	topN: z.number().int().positive().max(50).optional(),
};

export const LibraryRegisterInput = {
	rootPath: z.string().min(1),
	label: z.string().optional(),
	include: z.array(z.string()).optional(),
	exclude: z.array(z.string()).optional(),
};

export const LibraryReindexInput = {
	sourceId: z.string().optional(),
	worktreePath: z.string().optional(),
};

const LibraryHitSchema = z.object({
	snippet: z.string(),
	citation: z.object({
		sourceId: z.string(),
		filePath: z.string(),
		relPath: z.string(),
		lineStart: z.number(),
		lineEnd: z.number(),
		headingPath: z.array(z.string()),
	}),
	origin: z.object({ repoKey: z.string().optional(), name: z.string() }),
	value: z.object({
		docType: z.string(),
		statusHeader: z.string().optional(),
		mtimeMs: z.number(),
		pinned: z.boolean(),
	}),
	freshness: z.enum(["fresh", "stale"]),
	score: z.number(),
});

export const LibrarySearchResultSchema = z.object({
	hits: z.array(LibraryHitSchema),
	sourcesQueried: z.number(),
});
