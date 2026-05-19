import { describe, it, expect, vi, beforeEach } from "vitest";

// Deterministic: mock the detector so the test never depends on real env
// (CODEX_THREAD_ID etc.) or the mtime/history heuristic.
vi.mock("../../../src/lib/history/session-detect.js", () => ({
	detectCurrentSession: vi.fn(),
}));
import { detectCurrentSession } from "../../../src/lib/history/session-detect.js";
import { resolveLoggedSessionId, _resetSessionIdMemoForTest } from "../../../src/mcp/server.js";

const mockDetect = vi.mocked(detectCurrentSession);
beforeEach(() => {
	mockDetect.mockReset();
	_resetSessionIdMemoForTest();
});

describe("resolveLoggedSessionId", () => {
	it("returns the detected session id", () => {
		mockDetect.mockReturnValue({
			sessionId: "sess-xyz",
			source: "env:AI_CORTEX_SESSION_ID",
		});
		expect(resolveLoggedSessionId()).toBe("sess-xyz");
	});
	it("returns null when detection yields null", () => {
		mockDetect.mockReturnValue(null);
		expect(resolveLoggedSessionId()).toBeNull();
	});
	it("returns null (never throws) when detection throws", () => {
		mockDetect.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(() => resolveLoggedSessionId()).not.toThrow();
		expect(resolveLoggedSessionId()).toBeNull();
	});
});
