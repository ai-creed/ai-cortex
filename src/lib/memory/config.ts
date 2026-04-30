import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { memoryRootDir } from "./paths.js";

export type MemoryConfig = {
	aging: {
		candidateToTrashedDays: number;
		deprecatedToTrashedDays: number;
		mergedIntoToTrashedDays: number;
		trashedToPurgedDays: number;
		lowConfidenceThreshold: number;
	};
	promotion: Record<string, { reExtractionPromoteCount: number }>;
	extractor: {
		dedupCosine: number;
		reExtractionMatchCosine: number;
	};
	ranking: {
		weights: {
			semantic: number;
			scope: number;
			status: number;
			confidence: number;
			recency: number;
			source: number;
			link: number;
			typeMismatchPenalty: number;
		};
		recencyHalfLifeDays: number;
		candidatePoolSize: number;
		topK: number;
	};
	injection: {
		pinnedHardCap: number;
		pinnedSoftWarn: number;
		autoInjectTopK: number;
	};
};

export const DEFAULT_CONFIG: MemoryConfig = {
	aging: {
		candidateToTrashedDays: 90,
		deprecatedToTrashedDays: 180,
		mergedIntoToTrashedDays: 90,
		trashedToPurgedDays: 90,
		lowConfidenceThreshold: 0.4,
	},
	promotion: {
		decision: { reExtractionPromoteCount: 5 },
		gotcha:   { reExtractionPromoteCount: 3 },
		pattern:  { reExtractionPromoteCount: 2 },
		"how-to": { reExtractionPromoteCount: 3 },
	},
	extractor: {
		dedupCosine: 0.85,
		reExtractionMatchCosine: 0.92,
	},
	ranking: {
		weights: {
			semantic: 0.50, scope: 0.30, status: 0.10,
			confidence: 0.05, recency: 0.05, source: 0.10,
			link: 0.05, typeMismatchPenalty: 0.20,
		},
		recencyHalfLifeDays: 60,
		candidatePoolSize: 200,
		topK: 10,
	},
	injection: {
		pinnedHardCap: 20,
		pinnedSoftWarn: 10,
		autoInjectTopK: 5,
	},
};

function deepMerge<T>(base: T, overlay: Partial<T> | undefined): T {
	if (!overlay) return base;
	const out = { ...base } as Record<string, unknown>;
	const ov = overlay as Record<string, unknown>;
	for (const k of Object.keys(ov)) {
		const a = (base as Record<string, unknown>)[k];
		const b = ov[k];
		if (a && typeof a === "object" && !Array.isArray(a) && b && typeof b === "object" && !Array.isArray(b)) {
			out[k] = deepMerge(a, b as Partial<typeof a>);
		} else {
			out[k] = b;
		}
	}
	return out as T;
}

async function readJsonIfExists(p: string): Promise<Partial<{ memory: Partial<MemoryConfig> }>> {
	try {
		const text = await fs.readFile(p, "utf8");
		return JSON.parse(text);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw err;
	}
}

export async function loadMemoryConfig(repoKey: string): Promise<MemoryConfig> {
	const userPath = path.join(os.homedir(), ".config", "ai-cortex", "config.json");
	const repoPath = path.join(memoryRootDir(repoKey), "config.json");

	const [userJson, repoJson] = await Promise.all([
		readJsonIfExists(userPath),
		readJsonIfExists(repoPath),
	]);

	let cfg: MemoryConfig = DEFAULT_CONFIG;
	cfg = deepMerge(cfg, userJson.memory);
	cfg = deepMerge(cfg, repoJson.memory);
	return cfg;
}
