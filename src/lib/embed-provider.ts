// src/lib/embed-provider.ts
import { EmbeddingInferenceError, ModelLoadError } from "./models.js";

export const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;

export type EmbedProvider = {
	embed(texts: string[]): Promise<Float32Array[]>;
};

let providerCache: EmbedProvider | null = null;

export async function getProvider(): Promise<EmbedProvider> {
	if (providerCache) return providerCache;

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

	providerCache = {
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
				const vec = l2Normalize(output.data.slice(0, EMBEDDING_DIM));
				results.push(vec);
			}
			return results;
		},
	};
	return providerCache;
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
