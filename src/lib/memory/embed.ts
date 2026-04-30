import fs from "node:fs/promises";
import { memoryRootDir } from "./paths.js";
import { getProvider, MODEL_NAME, EMBEDDING_DIM } from "../embed-provider.js";
import { readVectorIndex, writeVectorIndex } from "../vector-sidecar.js";

export type MemoryVector = {
	memoryId: string;
	vector: Float32Array;
	dim: number;
	bodyHash: string;
};

function entryPathFor(memoryId: string): string {
	return `memory:${memoryId}`;
}

export async function upsertMemoryVector(
	repoKey: string,
	memoryId: string,
	title: string,
	body: string,
	bodyHash: string,
): Promise<void> {
	const dir = memoryRootDir(repoKey);
	await fs.mkdir(dir, { recursive: true });
	const provider = await getProvider();
	const [vector] = await provider.embed([`${title}\n\n${body}`]);
	const dim = EMBEDDING_DIM;

	const existing = await readVectorIndex(dir, MODEL_NAME);
	const entries =
		existing?.meta.entries.filter((e) => e.path !== entryPathFor(memoryId)) ??
		[];
	const matrixSize = (entries.length + 1) * dim;
	const matrix = new Float32Array(matrixSize);

	if (existing) {
		for (let i = 0; i < entries.length; i++) {
			const oldIdx = existing.meta.entries.findIndex(
				(e) => e.path === entries[i]!.path,
			);
			matrix.set(
				existing.matrix.slice(oldIdx * dim, (oldIdx + 1) * dim),
				i * dim,
			);
		}
	}
	matrix.set(vector!, entries.length * dim);
	entries.push({ path: entryPathFor(memoryId), hash: bodyHash });

	await writeVectorIndex(dir, {
		matrix,
		meta: { modelName: MODEL_NAME, dim, count: entries.length, entries },
	});
}

export async function readMemoryVector(
	repoKey: string,
	memoryId: string,
): Promise<MemoryVector | null> {
	const dir = memoryRootDir(repoKey);
	const idx = await readVectorIndex(dir, MODEL_NAME);
	if (!idx) return null;
	const target = entryPathFor(memoryId);
	const i = idx.meta.entries.findIndex((e) => e.path === target);
	if (i < 0) return null;
	const vec = idx.matrix.slice(i * idx.meta.dim, (i + 1) * idx.meta.dim);
	return {
		memoryId,
		vector: vec,
		dim: idx.meta.dim,
		bodyHash: idx.meta.entries[i]!.hash,
	};
}

export async function deleteMemoryVector(
	repoKey: string,
	memoryId: string,
): Promise<void> {
	const dir = memoryRootDir(repoKey);
	const idx = await readVectorIndex(dir, MODEL_NAME);
	if (!idx) return;
	const target = entryPathFor(memoryId);
	const keep = idx.meta.entries.filter((e) => e.path !== target);
	if (keep.length === idx.meta.count) return;
	const dim = idx.meta.dim;
	const matrix = new Float32Array(keep.length * dim);
	for (let i = 0; i < keep.length; i++) {
		const oldIdx = idx.meta.entries.findIndex((e) => e.path === keep[i]!.path);
		matrix.set(idx.matrix.slice(oldIdx * dim, (oldIdx + 1) * dim), i * dim);
	}
	await writeVectorIndex(dir, {
		matrix,
		meta: { modelName: MODEL_NAME, dim, count: keep.length, entries: keep },
	});
}
