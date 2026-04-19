// src/lib/vector-sidecar.ts
import fs from "node:fs";
import path from "node:path";
import { VectorIndexCorruptError } from "./models.js";

export type SidecarEntry = {
	path: string;
	hash: string;
};

export type SidecarMeta = {
	modelName: string;
	dim: number;
	count: number;
	entries: SidecarEntry[];
};

export type VectorIndex = {
	meta: SidecarMeta;
	matrix: Float32Array;
};

const BIN_FILE = ".vectors.bin";
const META_FILE = ".vectors.meta.json";

export function writeVectorIndex(dir: string, index: VectorIndex): void {
	// Best-effort atomic rename — no low-level fsync; orphaned .tmp files on crash are harmless.
	const binPath = path.join(dir, BIN_FILE);
	const metaPath = path.join(dir, META_FILE);
	const binTmp = binPath + ".tmp";
	const metaTmp = metaPath + ".tmp";

	fs.writeFileSync(
		binTmp,
		Buffer.from(index.matrix.buffer, index.matrix.byteOffset, index.matrix.byteLength),
	);
	fs.writeFileSync(metaTmp, JSON.stringify(index.meta), "utf8");
	fs.renameSync(metaTmp, metaPath);
	fs.renameSync(binTmp, binPath);
}

export function readVectorIndex(dir: string, modelName: string): VectorIndex | null {
	const binPath = path.join(dir, BIN_FILE);
	const metaPath = path.join(dir, META_FILE);

	if (!fs.existsSync(metaPath) || !fs.existsSync(binPath)) {
		return null;
	}

	let meta: SidecarMeta;
	try {
		meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as SidecarMeta;
	} catch {
		throw new VectorIndexCorruptError(`failed to parse sidecar meta: ${metaPath}`);
	}

	if (meta.modelName !== modelName) {
		return null;
	}

	if (
		typeof meta.dim !== "number" ||
		typeof meta.count !== "number" ||
		!Array.isArray(meta.entries)
	) {
		throw new VectorIndexCorruptError(`sidecar meta missing required fields: ${metaPath}`);
	}

	if (meta.entries.length !== meta.count) {
		throw new VectorIndexCorruptError(
			`sidecar entries.length (${meta.entries.length}) does not match meta.count (${meta.count}): ${metaPath}`,
		);
	}

	const binBuf = fs.readFileSync(binPath);
	const expectedBytes = meta.count * meta.dim * 4; // f32 = 4 bytes
	if (binBuf.byteLength !== expectedBytes) {
		throw new VectorIndexCorruptError(
			`sidecar .bin size mismatch: expected ${expectedBytes} bytes, got ${binBuf.byteLength}: ${binPath}`,
		);
	}

	const matrix = new Float32Array(
		binBuf.buffer,
		binBuf.byteOffset,
		meta.count * meta.dim,
	);

	return { meta, matrix };
}
