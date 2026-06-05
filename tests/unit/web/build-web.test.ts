import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

describe("web bundle build", () => {
	it("produces dist/web/graph/app3d.js and index.html", () => {
		execFileSync("node", ["scripts/build-web.mjs"], { stdio: "ignore" });
		const root = path.resolve("dist/web/graph");
		expect(fs.existsSync(path.join(root, "app3d.js"))).toBe(true);
		expect(fs.existsSync(path.join(root, "index.html"))).toBe(true);
		expect(fs.existsSync(path.join(root, "overlay.css"))).toBe(true);
	}, 60_000);
});
