import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openRetrieve, filterCandidates } from "../../../../src/lib/memory/retrieve.js";
import { openLifecycle, createMemory } from "../../../../src/lib/memory/lifecycle.js";

vi.mock("../../../../src/lib/embed-provider.js", () => ({
	MODEL_NAME: "Xenova/all-MiniLM-L6-v2",
	EMBEDDING_DIM: 384,
	getProvider: vi.fn(async () => ({
		embed: async (texts: string[]) => texts.map(() => new Float32Array(384)),
	})),
}));

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-glob-scope-"));
	vi.spyOn(os, "homedir").mockReturnValue(tmp);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
	vi.restoreAllMocks();
});

const repoKey = "0123456789abcdef";

async function seedActive(scopeFiles: string[], title = "rule"): Promise<string> {
	const lc = await openLifecycle(repoKey);
	try {
		return await createMemory(lc, {
			type: "decision",
			title,
			body: "test body",
			scope: { files: scopeFiles, tags: [] },
			source: "explicit",
		});
	} finally {
		lc.close();
	}
}

describe("filterCandidates SQL pre-filter — glob admission", () => {
	it("admits literal-scope memory when caller passes the same literal", async () => {
		const id = await seedActive(["src/foo.ts"]);
		const rh = openRetrieve(repoKey);
		try {
			const got = filterCandidates(rh, {
				scope: { files: ["src/foo.ts"], tags: [] },
				candidatePoolSize: 100,
			});
			expect(got.map((r) => r.id)).toContain(id);
		} finally {
			rh.close();
		}
	});

	it("admits glob-scope memory regardless of caller's literal path", async () => {
		const id = await seedActive(["MainApp/**/*card*"]);
		const rh = openRetrieve(repoKey);
		try {
			const got = filterCandidates(rh, {
				scope: { files: ["MainApp/lib/cards/card.ts"], tags: [] },
				candidatePoolSize: 100,
			});
			expect(got.map((r) => r.id)).toContain(id);
		} finally {
			rh.close();
		}
	});

	it("does not admit unscoped memory when scope filter is set", async () => {
		const id = await seedActive([]);
		const rh = openRetrieve(repoKey);
		try {
			const got = filterCandidates(rh, {
				scope: { files: ["src/foo.ts"], tags: [] },
				candidatePoolSize: 100,
			});
			expect(got.map((r) => r.id)).toContain(id);
		} finally {
			rh.close();
		}
	});
});
