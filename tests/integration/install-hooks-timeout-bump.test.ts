import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	installHooks,
	getSettingsPath,
	hooksMigrationStatus,
} from "../../src/lib/history/hooks-install.js";

let prevHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
	prevHome = process.env.HOME;
	tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-install-timeout-"));
	process.env.HOME = tmpHome;
});
afterEach(() => {
	if (prevHome) process.env.HOME = prevHome;
	else delete process.env.HOME;
	try {
		fs.rmSync(tmpHome, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("install-hooks Claude PreToolUse timeout", () => {
	it("writes timeout: 10 (seconds, not 5) for the surface-hook entry", async () => {
		const result = await installHooks({ yes: true, answerForTest: "y" });
		expect(result).toBe("installed");

		const settingsPath = getSettingsPath();
		const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		const preToolUse = parsed?.hooks?.PreToolUse ?? [];
		const surfaceEntry = preToolUse.find((e: { hooks: { command: string }[] }) =>
			e.hooks?.some((h) => h.command?.includes("memory surface-hook")),
		);
		expect(surfaceEntry).toBeDefined();
		const cmd = surfaceEntry.hooks.find((h: { command: string }) =>
			h.command?.includes("memory surface-hook"),
		);
		// Claude Code hook timeouts are seconds (existing constant
		// SURFACE_HOOK_TIMEOUT_SEC). Bumped from 5 → 10 per Track B spec §6.2.
		expect(cmd.timeout).toBe(10);
	});
});

describe("install-hooks Claude SessionStart workflow-rules", () => {
	it("writes Claude SessionStart entry with matcher 'startup|resume|clear|compact' invoking list-workflow-rules --format=hook", async () => {
		const result = await installHooks({ yes: true, answerForTest: "y" });
		expect(result).toBe("installed");

		const settingsPath = getSettingsPath();
		const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		const events = parsed?.hooks?.SessionStart ?? [];
		const wf = events.find((e: { hooks: { command: string }[] }) =>
			e.hooks?.some((h) => h.command?.includes("memory list-workflow-rules")),
		);
		expect(wf).toBeDefined();
		expect(wf.matcher).toBe("startup|resume|clear|compact");
		const handler = wf.hooks.find((h: { command: string }) =>
			h.command?.includes("memory list-workflow-rules"),
		);
		expect(handler.type).toBe("command");
		expect(handler.command).toContain("--format=hook");
		expect(handler.timeout).toBe(10);
	});
});

describe("hooksMigrationStatus recognizes legacy installs as needing migration", () => {
	it("returns needsInstall:true when settings.json is missing the SessionStart workflow-rules entry", () => {
		const settingsDir = path.join(tmpHome, ".claude");
		fs.mkdirSync(settingsDir, { recursive: true });
		fs.writeFileSync(
			path.join(settingsDir, "settings.json"),
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{
							matcher: "Edit|Write|MultiEdit",
							hooks: [
								{
									type: "command",
									command: "ai-cortex memory surface-hook",
									timeout: 10,
								},
							],
						},
					],
					// No SessionStart entry — the new workflow-rules install is missing.
				},
			}),
		);
		const status = hooksMigrationStatus();
		expect(status.needsInstall).toBe(true);
	});

	it("returns needsInstall:true when settings.json has the old timeout: 5", () => {
		const settingsDir = path.join(tmpHome, ".claude");
		fs.mkdirSync(settingsDir, { recursive: true });
		fs.writeFileSync(
			path.join(settingsDir, "settings.json"),
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{
							matcher: "Edit|Write|MultiEdit",
							hooks: [
								{
									type: "command",
									command: "ai-cortex memory surface-hook",
									timeout: 5,
								},
							],
						},
					],
				},
			}),
		);
		const status = hooksMigrationStatus();
		expect(status.needsInstall).toBe(true);
	});
});
