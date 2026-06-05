import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWebDir } from "../../../src/cli/graph.js";

// The bundle (app3d.js) lives only in dist/web/graph. resolveWebDir must find it
// whether the CLI runs from the built layout (dist/src/cli) or from source via
// tsx (src/cli) -- the latter previously pointed at the bundle-less source dir
// and served a blank graph.
function mkBundle(root: string): string {
	const dir = path.join(root, "dist", "web", "graph");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "app3d.js"), "// bundle");
	return dir;
}

describe("resolveWebDir", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-webdir-"));
	});
	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("finds the built bundle when run from source via tsx (src/cli)", () => {
		const bundle = mkBundle(tmp);
		const here = path.join(tmp, "src", "cli");
		expect(resolveWebDir(here)).toBe(bundle);
	});

	it("finds the bundle when run from the built dist layout (dist/src/cli)", () => {
		const bundle = mkBundle(tmp);
		const here = path.join(tmp, "dist", "src", "cli");
		expect(resolveWebDir(here)).toBe(bundle);
	});

	it("falls back to the built-layout path when no bundle exists yet", () => {
		const here = path.join(tmp, "dist", "src", "cli");
		expect(resolveWebDir(here)).toBe(path.join(tmp, "dist", "web", "graph"));
	});
});
