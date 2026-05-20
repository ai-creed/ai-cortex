// tests/unit/lib/migration-notifier.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/history/hooks-install.js", () => ({
	hooksMigrationStatus: vi.fn(),
}));

import { hooksMigrationStatus } from "../../../src/lib/history/hooks-install.js";
import { getHookMigrationNotice } from "../../../src/lib/migration-notifier.js";

describe("getHookMigrationNotice", () => {
	beforeEach(() => {
		delete process.env.AI_CORTEX_NO_UPDATE_CHECK;
		vi.mocked(hooksMigrationStatus).mockReset();
	});

	afterEach(() => {
		delete process.env.AI_CORTEX_NO_UPDATE_CHECK;
	});

	it("returns null when hooks are current", () => {
		vi.mocked(hooksMigrationStatus).mockReturnValue({ needsInstall: false });
		expect(getHookMigrationNotice()).toBeNull();
	});

	it("returns a notice when hooks need install", () => {
		vi.mocked(hooksMigrationStatus).mockReturnValue({ needsInstall: true });
		const notice = getHookMigrationNotice();
		expect(notice).not.toBeNull();
		expect(notice).toContain("ai-cortex history install-hooks");
		expect(notice).toContain("out of date");
	});

	it("returns null when AI_CORTEX_NO_UPDATE_CHECK=1 even if hooks are stale", () => {
		process.env.AI_CORTEX_NO_UPDATE_CHECK = "1";
		vi.mocked(hooksMigrationStatus).mockReturnValue({ needsInstall: true });
		expect(getHookMigrationNotice()).toBeNull();
	});

	it("returns null (does not throw) when hooksMigrationStatus throws", () => {
		vi.mocked(hooksMigrationStatus).mockImplementation(() => {
			throw new Error("synthetic failure");
		});
		expect(() => getHookMigrationNotice()).not.toThrow();
		expect(getHookMigrationNotice()).toBeNull();
	});

	it("notice contains no ANSI escape sequences (MCP surface)", () => {
		vi.mocked(hooksMigrationStatus).mockReturnValue({ needsInstall: true });
		const notice = getHookMigrationNotice();
		// eslint-disable-next-line no-control-regex
		expect(notice).not.toMatch(/\x1b\[[0-9;]*m/);
	});
});
