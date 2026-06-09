import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
	AI_CORTEX_TOOL_NAMES,
	isCortexTool,
} from "../../../../src/lib/stats/tool-names.js";

describe("AI_CORTEX_TOOL_NAMES", () => {
	it("contains 35 entries (matching src/mcp/server.ts registrations)", () => {
		expect(AI_CORTEX_TOOL_NAMES.size).toBe(35);
	});

	it("matches every server.tool/server.registerTool call site in src/mcp/server.ts", () => {
		const serverPath = path.resolve(
			__dirname,
			"../../../../src/mcp/server.ts",
		);
		const src = fs.readFileSync(serverPath, "utf8");
		// Grep for the call-site pattern, capture the canonical first arg.
		const re = /server\.(?:registerTool|tool)\(\s*"([a-z_]+)"/g;
		const found = new Set<string>();
		for (const m of src.matchAll(re)) found.add(m[1]);
		// Both sets identical — no drift in either direction.
		expect([...found].sort()).toEqual([...AI_CORTEX_TOOL_NAMES].sort());
	});

	it("isCortexTool returns true for known tools, false for Claude Code builtins", () => {
		expect(isCortexTool("recall_memory")).toBe(true);
		expect(isCortexTool("suggest_files")).toBe(true);
		expect(isCortexTool("Read")).toBe(false);
		expect(isCortexTool("Bash")).toBe(false);
		expect(isCortexTool("exec_command")).toBe(false);
	});
});
