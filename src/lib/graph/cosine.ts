// src/lib/graph/cosine.ts
// Memory vectors are already L2-normalized at write time, so cosine
// similarity reduces to the dot product. Callers must pass equal-length
// vectors (same embedding model => same dim).

export function dot(a: Float32Array, b: Float32Array): number {
	let s = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
	return s;
}
