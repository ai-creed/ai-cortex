// src/lib/embed-provider.ts
import { EmbeddingInferenceError, ModelLoadError } from "./models.js";

export const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;

export type EmbedProvider = {
	embed(texts: string[]): Promise<Float32Array[]>;
};

let providerPromise: Promise<EmbedProvider> | null = null;

export async function getProvider(): Promise<EmbedProvider> {
	if (!providerPromise) providerPromise = _loadProvider();
	return providerPromise;
}

async function _loadProvider(): Promise<EmbedProvider> {
	let pipe: (text: string) => Promise<{ data: Float32Array; dims: number[] }>;
	try {
		const { pipeline, env } = await import("@xenova/transformers");
		env.allowLocalModels = false;
		env.useBrowserCache = false;
		pipe = (await pipeline("feature-extraction", MODEL_NAME, {
			quantized: true,
		})) as typeof pipe;
	} catch (err) {
		throw new ModelLoadError(
			`failed to load embedding model ${MODEL_NAME}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return {
		async embed(texts: string[]): Promise<Float32Array[]> {
			const results: Float32Array[] = [];
			for (const text of texts) {
				let output: { data: Float32Array; dims: number[] };
				try {
					output = await pipe(text);
				} catch (err) {
					throw new EmbeddingInferenceError(
						`embedding inference failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
				if (output.data.length < EMBEDDING_DIM) {
					throw new EmbeddingInferenceError(
						`model returned ${output.data.length} dims, expected ${EMBEDDING_DIM}`,
					);
				}
				const vec = l2Normalize(output.data.slice(0, EMBEDDING_DIM));
				results.push(vec);
			}
			return results;
		},
	};
}

function l2Normalize(vec: Float32Array): Float32Array {
	let norm = 0;
	for (let i = 0; i < vec.length; i++) {
		norm += vec[i]! * vec[i]!;
	}
	norm = Math.sqrt(norm);
	if (norm === 0) return vec;
	const out = new Float32Array(vec.length);
	for (let i = 0; i < vec.length; i++) {
		out[i] = vec[i]! / norm;
	}
	return out;
}

// --- Additive: model-parametric, mean-pooled provider for the library module ---
// Separate from getProvider() so existing sidecar vectors and the suggest ranker
// keep their exact current behavior. Output length is the model's true dim.
const pooledProviders = new Map<string, Promise<EmbedProvider>>();

export async function getPooledProvider(
	modelName: string,
): Promise<EmbedProvider> {
	let p = pooledProviders.get(modelName);
	if (!p) {
		p = _loadPooledProvider(modelName);
		pooledProviders.set(modelName, p);
	}
	return p;
}

async function _loadPooledProvider(modelName: string): Promise<EmbedProvider> {
	let pipe: (
		text: string,
		opts: { pooling: "mean"; normalize: boolean },
	) => Promise<{ data: Float32Array }>;
	try {
		const { pipeline, env } = await import("@xenova/transformers");
		env.allowLocalModels = false;
		env.useBrowserCache = false;
		pipe = (await pipeline("feature-extraction", modelName, {
			quantized: true,
		})) as typeof pipe;
	} catch (err) {
		throw new ModelLoadError(
			`failed to load embedding model ${modelName}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	return {
		async embed(texts: string[]): Promise<Float32Array[]> {
			const out: Float32Array[] = [];
			for (const text of texts) {
				let r: { data: Float32Array };
				try {
					r = await pipe(text, { pooling: "mean", normalize: true });
				} catch (err) {
					throw new EmbeddingInferenceError(
						`embedding inference failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
				out.push(Float32Array.from(r.data));
			}
			return out;
		},
	};
}
