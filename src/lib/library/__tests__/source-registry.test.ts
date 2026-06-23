// src/lib/library/__tests__/source-registry.test.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getSource,
	listSources,
	registerSource,
	removeSource,
	updateSource,
} from "../source-registry.js";

const NOW = "2026-06-23T00:00:00.000Z";

describe("source-registry", () => {
	let cacheHome: string;
	let dir: string;
	beforeEach(() => {
		cacheHome = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "lib-reg-cache-")),
		);
		process.env.AI_CORTEX_CACHE_HOME = cacheHome;
		dir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "lib-reg-dir-")),
		);
	});
	afterEach(() => {
		delete process.env.AI_CORTEX_CACHE_HOME;
		fs.rmSync(cacheHome, { recursive: true, force: true });
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("starts empty (opt-in: nothing indexed until registered)", () => {
		expect(listSources()).toEqual([]);
	});

	it("registers a plain directory as kind 'dir'", () => {
		const { source } = registerSource({
			rootPath: dir,
			label: "my docs",
			nowIso: NOW,
		});
		expect(source.kind).toBe("dir");
		expect(source.origin.name).toBe("my docs");
		expect(source.origin.repoKey).toBeUndefined();
		expect(source.status).toBe("ok");
		expect(listSources().length).toBe(1);
		expect(getSource(source.id)?.rootPath).toBe(dir);
	});

	it("detects a git repo and records origin.repoKey", () => {
		execFileSync("git", ["init", "-q"], { cwd: dir });
		const { source } = registerSource({ rootPath: dir, nowIso: NOW });
		expect(source.kind).toBe("repo");
		expect(source.origin.repoKey).toMatch(/^[0-9a-f]{16}$/);
	});

	it("warns when a new source overlaps an existing one", () => {
		registerSource({ rootPath: dir, nowIso: NOW });
		const child = path.join(dir, "sub");
		fs.mkdirSync(child);
		const { warnings } = registerSource({ rootPath: child, nowIso: NOW });
		expect(warnings.some((w) => w.includes("overlap"))).toBe(true);
	});

	it("updates and removes sources", () => {
		const { source } = registerSource({ rootPath: dir, nowIso: NOW });
		updateSource(source.id, { lastIndexedAt: NOW, status: "ok" });
		expect(getSource(source.id)?.lastIndexedAt).toBe(NOW);
		expect(removeSource(source.id)).toBe(true);
		expect(listSources()).toEqual([]);
	});
});
