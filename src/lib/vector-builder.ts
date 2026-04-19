// src/lib/vector-builder.ts
import os from "node:os";
import path from "node:path";
import { EMBEDDING_DIM, MODEL_NAME, getProvider } from "./embed-provider.js";
import type { SidecarEntry, VectorIndex } from "./vector-sidecar.js";
import { writeVectorIndex } from "./vector-sidecar.js";
import type { RepoCache } from "./models.js";

/**
 * Returns the directory where sidecar vector files (.vectors.bin, .vectors.meta.json)
 * are stored for a given worktree key. Mirrors the base path used by cache-store.ts
 * (getCacheDir uses ~/.cache/ai-cortex/v1/<repoKey>), but keyed per worktreeKey so
 * the sidecar is isolated per worktree.
 */
export function getSidecarDir(worktreeKey: string): string {
	return path.join(os.homedir(), ".cache", "ai-cortex", "v1", worktreeKey);
}

/**
 * Embeds all file-kind entries in the cache and writes a fresh VectorIndex to disk.
 */
export async function buildVectorIndex(
	worktreePath: string,
	cache: RepoCache,
): Promise<VectorIndex> {
	const provider = await getProvider();
	const files = cache.files.filter((f) => f.kind === "file");

	const entries: SidecarEntry[] = [];
	const vectors: Float32Array[] = [];

	for (const file of files) {
		const [vec] = await provider.embed([file.path]);
		entries.push({ path: file.path, hash: file.contentHash ?? "" });
		vectors.push(vec!);
	}

	const matrix = concatVectors(vectors, EMBEDDING_DIM);
	const index: VectorIndex = {
		meta: {
			modelName: MODEL_NAME,
			dim: EMBEDDING_DIM,
			count: entries.length,
			entries,
		},
		matrix,
	};

	const sidecarDir = getSidecarDir(cache.worktreeKey);
	writeVectorIndex(sidecarDir, index);
	return index;
}

/**
 * Delta-refreshes the vector index — only re-embeds files whose hash changed or
 * that are new. Unchanged files reuse their existing vector slice.
 */
export async function refreshVectorIndex(
	worktreePath: string,
	cache: RepoCache,
	existing: VectorIndex,
): Promise<VectorIndex> {
	const provider = await getProvider();
	const files = cache.files.filter((f) => f.kind === "file");

	// Build O(1) lookup: path -> { row index in existing matrix, hash }
	const existingMap = new Map<string, { idx: number; hash: string }>();
	for (let i = 0; i < existing.meta.entries.length; i++) {
		const entry = existing.meta.entries[i]!;
		existingMap.set(entry.path, { idx: i, hash: entry.hash });
	}

	const entries: SidecarEntry[] = [];
	const vectors: Float32Array[] = [];

	for (const file of files) {
		const fileHash = file.contentHash ?? "";
		const cached = existingMap.get(file.path);

		if (cached && cached.hash === fileHash) {
			// Reuse the existing vector row
			const start = cached.idx * EMBEDDING_DIM;
			vectors.push(existing.matrix.slice(start, start + EMBEDDING_DIM));
		} else {
			// New or modified — re-embed
			const [vec] = await provider.embed([file.path]);
			vectors.push(vec!);
		}

		entries.push({ path: file.path, hash: fileHash });
	}

	const matrix = concatVectors(vectors, EMBEDDING_DIM);
	const index: VectorIndex = {
		meta: {
			modelName: MODEL_NAME,
			dim: EMBEDDING_DIM,
			count: entries.length,
			entries,
		},
		matrix,
	};

	const sidecarDir = getSidecarDir(cache.worktreeKey);
	writeVectorIndex(sidecarDir, index);
	return index;
}

function concatVectors(vectors: Float32Array[], dim: number): Float32Array {
	const out = new Float32Array(vectors.length * dim);
	for (let i = 0; i < vectors.length; i++) {
		out.set(vectors[i]!, i * dim);
	}
	return out;
}
