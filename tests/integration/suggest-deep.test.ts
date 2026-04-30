// tests/integration/suggest-deep.test.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { suggestRepo } from "../../src/lib/suggest.js";

const ROOT_DIR = fileURLToPath(new URL(".", import.meta.url));

let tmp: string;

beforeAll(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deep-repo-"));
	const src = path.resolve(ROOT_DIR, "../fixtures/deep-repo");
	fs.cpSync(src, tmp, { recursive: true });
	execFileSync("git", ["init", "-q"], { cwd: tmp });
	execFileSync("git", ["-C", tmp, "config", "user.email", "test@test.com"]);
	execFileSync("git", ["-C", tmp, "config", "user.name", "Test"]);
	execFileSync("git", ["-C", tmp, "config", "commit.gpgsign", "false"]);
	execFileSync("git", ["add", "-A"], { cwd: tmp });
	execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: tmp });
});

afterAll(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("suggest deep — synthetic repo", () => {
	it("ranks CardTitleEditor.tsx first for the failing natural-language task", async () => {
		const result = await suggestRepo(
			tmp,
			"card creation title editing in My Work right panel",
			{ mode: "deep", limit: 5, poolSize: 60 },
		);
		expect(result.mode).toBe("deep");
		expect(result.results[0]?.path).toContain("CardTitleEditor.tsx");
	});

	it("content snippet includes RightPanel line", async () => {
		const result = await suggestRepo(tmp, "right panel", {
			mode: "deep",
			limit: 5,
			poolSize: 60,
		});
		if (result.mode !== "deep") throw new Error("expected deep mode");
		const top = result.results.find((r) =>
			r.path.endsWith("CardTitleEditor.tsx"),
		);
		const hasRightPanel = top?.contentHits?.some((h) =>
			h.snippet.includes("RightPanel"),
		);
		expect(hasRightPanel).toBe(true);
	});

	it("completes within 1000ms on the tiny corpus", async () => {
		const result = await suggestRepo(tmp, "card title", {
			mode: "deep",
			limit: 5,
			poolSize: 60,
		});
		expect(result.durationMs).toBeLessThan(1000);
	});

	it("omits trigramMatches from results by default", async () => {
		const result = await suggestRepo(
			tmp,
			"card creation title editing in My Work right panel",
			{ mode: "deep", limit: 5, poolSize: 60 },
		);
		expect(result.mode).toBe("deep");
		if (result.mode !== "deep") throw new Error("expected deep");
		for (const item of result.results) {
			expect(item).not.toHaveProperty("trigramMatches");
		}
	});

	it("includes trigramMatches when verbose is true", async () => {
		const result = await suggestRepo(
			tmp,
			"card creation title editing in My Work right panel",
			{ mode: "deep", limit: 5, poolSize: 60, verbose: true },
		);
		expect(result.mode).toBe("deep");
		if (result.mode !== "deep") throw new Error("expected deep");
		const withTrigrams = result.results.filter(
			(item) => item.trigramMatches && item.trigramMatches.length > 0,
		);
		expect(withTrigrams.length).toBeGreaterThan(0);
	});
});
