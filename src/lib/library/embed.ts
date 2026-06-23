// src/lib/library/embed.ts
import { getPooledProvider } from "../embed-provider.js";
import type { Embedder } from "./types.js";

// gte-small: 384-dim, 512-token, needs no query-instruction prefix (unlike bge).
export const LIBRARY_EMBED_MODEL = "Xenova/gte-small";

export async function getLibraryEmbedder(
	modelId: string = LIBRARY_EMBED_MODEL,
): Promise<Embedder> {
	const provider = await getPooledProvider(modelId);
	const [probe] = await provider.embed(["dimension probe"]);
	if (!probe)
		throw new Error(`library embedder produced no vector for model ${modelId}`);
	return {
		modelId,
		dim: probe.length,
		embed: (texts) => provider.embed(texts),
	};
}
