import { vi } from "vitest";

// Default global mock for the embed provider. Wired via vitest.config.ts
// `setupFiles` so any test that ends up calling getProvider() (e.g. through
// createMemory → upsertMemoryVector) gets a deterministic local embedder
// instead of triggering the real Xenova/all-MiniLM-L6-v2 download.
//
// Why a global default: ~15 memory-touching unit/integration tests do not
// mock the provider themselves. Each release blocked on a HuggingFace CDN
// hiccup re-downloading the ~23 MB model. This setup makes the test suite
// hermetic — no network, no model parse, no flake.
//
// Why character-trigram hashing (not zero vectors): tests that exercise
// dedup / pattern extraction / bootstrap idempotency rely on cosine
// similarity between embeddings of similar text. A zero-vector mock makes
// every cosine ill-defined; a hash-of-token mock makes shared tokens but
// not shared morphology score equal weight. Trigram bag-of-features yields
// a smooth cosine signal: identical text → 1.0, highly similar text → high,
// unrelated text → low. Mirrors the trigram logic the deep ranker already
// uses in src/lib/trigram-index.ts.
//
// Per-test override: tests that need to control the returned vector (e.g.
// surface.test.ts driving cosine-threshold cases) declare their own
// `vi.mock("../../../../src/lib/embed-provider.js", ...)` at file scope;
// vitest hoists per-file mocks above setupFiles mocks, so the local factory
// wins for that test file. Tests that need the REAL provider (e.g.
// embed-provider.test.ts itself) call `vi.unmock("../../../src/lib/embed-provider.js")`
// at the top of the file.

const DIM = 384;

function fakeEmbed(text: string): Float32Array {
	const v = new Float32Array(DIM);
	const norm = text.toLowerCase();
	for (let i = 0; i + 3 <= norm.length; i++) {
		// FNV-1a-ish hash of the trigram
		let h = 2166136261 >>> 0;
		for (let j = 0; j < 3; j++) {
			h ^= norm.charCodeAt(i + j);
			h = Math.imul(h, 16777619) >>> 0;
		}
		v[h % DIM]! += 1;
	}
	// L2-normalize so cosine = dot product.
	let mag = 0;
	for (let i = 0; i < DIM; i++) mag += v[i]! * v[i]!;
	mag = Math.sqrt(mag);
	if (mag > 0) {
		for (let i = 0; i < DIM; i++) v[i]! /= mag;
	}
	return v;
}

vi.mock("../../src/lib/embed-provider.js", () => ({
	MODEL_NAME: "Xenova/all-MiniLM-L6-v2",
	EMBEDDING_DIM: DIM,
	getProvider: vi.fn(async () => ({
		embed: async (texts: string[]) => texts.map(fakeEmbed),
	})),
}));
