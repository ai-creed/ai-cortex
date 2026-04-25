// tests/unit/mcp/search-history.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../../../src/mcp/server.js";
import { writeSession } from "../../../src/lib/history/store.js";
import { HISTORY_SCHEMA_VERSION } from "../../../src/lib/history/types.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-mcp-history-"));
	vi.spyOn(os, "homedir").mockReturnValue(tmp);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("MCP search_history tool", () => {
	it("registers a search_history tool", () => {
		const server = createServer();
		// Asserts no exception is thrown during registration.
		expect(server).toBeDefined();
	});

	it("first call prepends the notice; second call does not", async () => {
		// Use a non-git cwd so the handler returns the friendly "not in a git repo" branch.
		// That branch still goes through maybeNotice(), which is what we're testing.
		const { resetFirstCallNoticeForTest, hasNoticeBeenSent, handleSearchHistory } =
			await import("../../../src/mcp/server.js");
		resetFirstCallNoticeForTest();
		expect(hasNoticeBeenSent()).toBe(false);

		const first = await handleSearchHistory({ query: "alpha", path: tmp });
		expect(first.content[0].text).toContain("history: capture active");
		expect(hasNoticeBeenSent()).toBe(true);

		const second = await handleSearchHistory({ query: "alpha", path: tmp });
		expect(second.content[0].text).not.toContain("history: capture");
	});

	it("notice reflects disabled state when AI_CORTEX_HISTORY=0", async () => {
		const { resetFirstCallNoticeForTest, handleSearchHistory } =
			await import("../../../src/mcp/server.js");
		resetFirstCallNoticeForTest();
		process.env.AI_CORTEX_HISTORY = "0";
		try {
			const r = await handleSearchHistory({ query: "alpha", path: tmp });
			expect(r.content[0].text).toContain("history: capture disabled");
		} finally {
			delete process.env.AI_CORTEX_HISTORY;
		}
	});
});
