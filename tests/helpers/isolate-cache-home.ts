import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Wired via vitest.config.ts setupFiles. Pins AI_CORTEX_CACHE_HOME to a
// session-scoped tmpdir so tests that touch the cache (directly via
// indexRepo/rehydrateRepo/etc. or through MCP handlers) never write to the
// user's real ~/.cache/ai-cortex/v1/. Tests that assert the real
// homedir-based default path must `delete process.env.AI_CORTEX_CACHE_HOME`
// in their own beforeEach (they mock os.homedir and want the fallback).
const sessionTmp = fs.mkdtempSync(
	path.join(os.tmpdir(), "ai-cortex-test-cache-"),
);
process.env.AI_CORTEX_CACHE_HOME = sessionTmp;
process.on("exit", () => {
	try {
		fs.rmSync(sessionTmp, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});
