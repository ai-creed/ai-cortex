import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isHistoryEnabled,
	getRawRetentionDays,
	getHistoryDisabledFlagPath,
} from "../../../../src/lib/history/config.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-history-config-"));
	vi.spyOn(os, "homedir").mockReturnValue(tmp);
	delete process.env.AI_CORTEX_HISTORY;
	delete process.env.AI_CORTEX_HISTORY_RAW_DAYS;
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("isHistoryEnabled", () => {
	it("defaults to true", () => {
		expect(isHistoryEnabled()).toBe(true);
	});

	it("returns false when AI_CORTEX_HISTORY=0", () => {
		process.env.AI_CORTEX_HISTORY = "0";
		expect(isHistoryEnabled()).toBe(false);
	});

	it("returns true when AI_CORTEX_HISTORY=1", () => {
		process.env.AI_CORTEX_HISTORY = "1";
		expect(isHistoryEnabled()).toBe(true);
	});

	it("returns false when flag file present and env unset", () => {
		fs.mkdirSync(path.dirname(getHistoryDisabledFlagPath()), {
			recursive: true,
		});
		fs.writeFileSync(getHistoryDisabledFlagPath(), "");
		expect(isHistoryEnabled()).toBe(false);
	});

	it("env var overrides flag file", () => {
		fs.mkdirSync(path.dirname(getHistoryDisabledFlagPath()), {
			recursive: true,
		});
		fs.writeFileSync(getHistoryDisabledFlagPath(), "");
		process.env.AI_CORTEX_HISTORY = "1";
		expect(isHistoryEnabled()).toBe(true);
	});
});

describe("getRawRetentionDays", () => {
	it("defaults to 30", () => {
		expect(getRawRetentionDays()).toBe(30);
	});

	it("reads env var when valid", () => {
		process.env.AI_CORTEX_HISTORY_RAW_DAYS = "60";
		expect(getRawRetentionDays()).toBe(60);
	});

	it("clamps to max 90", () => {
		process.env.AI_CORTEX_HISTORY_RAW_DAYS = "180";
		expect(getRawRetentionDays()).toBe(90);
	});

	it("clamps to min 0", () => {
		process.env.AI_CORTEX_HISTORY_RAW_DAYS = "-5";
		expect(getRawRetentionDays()).toBe(0);
	});

	it("falls back to default on garbage", () => {
		process.env.AI_CORTEX_HISTORY_RAW_DAYS = "not-a-number";
		expect(getRawRetentionDays()).toBe(30);
	});
});
