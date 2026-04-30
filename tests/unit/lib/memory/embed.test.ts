import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
	upsertMemoryVector,
	readMemoryVector,
} from "../../../../src/lib/memory/embed.js";

let tmp: string;
const repoKey = "vec-test";

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ai-cortex-vec-"));
	process.env.AI_CORTEX_CACHE_HOME = tmp;
});
afterEach(() => {
	delete process.env.AI_CORTEX_CACHE_HOME;
});

describe("upsertMemoryVector / readMemoryVector", () => {
	it("writes a vector for a memory and reads it back", async () => {
		await upsertMemoryVector(repoKey, "mem-x", "title", "body", "hash-1");
		const v = await readMemoryVector(repoKey, "mem-x");
		expect(v).not.toBeNull();
		expect(v!.dim).toBeGreaterThan(0);
		expect(v!.vector.length).toBe(v!.dim);
		expect(v!.bodyHash).toBe("hash-1");
	}, 30_000);

	it("returns null when no vector exists for memory", async () => {
		const v = await readMemoryVector(repoKey, "nonexistent-id");
		expect(v).toBeNull();
	}, 30_000);
});
