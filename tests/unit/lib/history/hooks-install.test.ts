import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installHooks, uninstallHooks, getSettingsPath, HOOK_COMMAND_MARKER } from "../../../../src/lib/history/hooks-install.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-history-hooks-"));
	vi.spyOn(os, "homedir").mockReturnValue(tmp);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("installHooks", () => {
	it("creates settings.json with hooks if absent (yes:true)", async () => {
		await installHooks({ yes: true });
		const s = JSON.parse(fs.readFileSync(getSettingsPath(), "utf8"));
		expect(s.hooks.PreCompact[0].hooks[0].command).toContain(HOOK_COMMAND_MARKER);
		expect(s.hooks.SessionEnd[0].hooks[0].command).toContain(HOOK_COMMAND_MARKER);
	});

	it("appends to existing hooks without duplicating", async () => {
		fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true });
		fs.writeFileSync(
			getSettingsPath(),
			JSON.stringify({ hooks: { PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "other" }] }] } }),
		);
		await installHooks({ yes: true });
		const s = JSON.parse(fs.readFileSync(getSettingsPath(), "utf8"));
		expect(s.hooks.PreCompact).toHaveLength(2);
	});

	it("idempotent: running twice does not duplicate our entry", async () => {
		await installHooks({ yes: true });
		await installHooks({ yes: true });
		const s = JSON.parse(fs.readFileSync(getSettingsPath(), "utf8"));
		const ours = s.hooks.PreCompact.filter((entry: { hooks: { command: string }[] }) =>
			(entry.hooks ?? []).some((h) => h.command.includes(HOOK_COMMAND_MARKER)),
		);
		expect(ours).toHaveLength(1);
	});

	it("writes hooks in the correct Claude Code schema shape", async () => {
		await installHooks({ yes: true });
		const s = JSON.parse(fs.readFileSync(getSettingsPath(), "utf8"));
		for (const evt of ["PreCompact", "SessionEnd"]) {
			const entries = s.hooks[evt];
			expect(Array.isArray(entries)).toBe(true);
			for (const entry of entries) {
				expect(typeof entry.matcher).toBe("string");
				expect(Array.isArray(entry.hooks)).toBe(true);
				for (const h of entry.hooks) {
					expect(h.type).toBe("command");
					expect(typeof h.command).toBe("string");
				}
			}
		}
	});

	it("writes a backup before any modification", async () => {
		fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true });
		fs.writeFileSync(getSettingsPath(), "{}");
		await installHooks({ yes: true });
		const dir = path.dirname(getSettingsPath());
		const backups = fs.readdirSync(dir).filter((n) => n.startsWith("settings.json.bak."));
		expect(backups.length).toBeGreaterThan(0);
	});

	it("refuses to write when existing settings.json fails to parse", async () => {
		fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true });
		fs.writeFileSync(getSettingsPath(), "{ not json");
		await expect(installHooks({ yes: true })).rejects.toThrow(/parse/i);
		// Original file should still be the garbage we wrote — no overwrite.
		expect(fs.readFileSync(getSettingsPath(), "utf8")).toBe("{ not json");
	});

	it("idempotent run with yes:true is silent on stdout (no diff/confirm)", async () => {
		await installHooks({ yes: true });
		const writes: string[] = [];
		const orig = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;
		try {
			await installHooks({ yes: true }); // already installed → no-op, no output
		} finally {
			process.stdout.write = orig;
		}
		expect(writes.join("")).toBe("");
	});

	it("interactive run prints diff and aborts on 'n' answer", async () => {
		const writes: string[] = [];
		const origWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;
		try {
			await installHooks({ yes: false, answerForTest: "n" });
		} finally {
			process.stdout.write = origWrite;
		}
		expect(writes.join("")).toMatch(/^[+-]/m); // diff lines printed
		expect(fs.existsSync(getSettingsPath())).toBe(false); // aborted
	});
});

describe("uninstallHooks", () => {
	it("removes only entries with our marker", async () => {
		await installHooks({ yes: true });
		const beforeOther = { matcher: "", hooks: [{ type: "command", command: "untouchable" }] };
		const s = JSON.parse(fs.readFileSync(getSettingsPath(), "utf8"));
		s.hooks.PreCompact.push(beforeOther);
		fs.writeFileSync(getSettingsPath(), JSON.stringify(s));
		await uninstallHooks({ yes: true });
		const after = JSON.parse(fs.readFileSync(getSettingsPath(), "utf8"));
		expect(after.hooks.PreCompact).toContainEqual(beforeOther);
		expect(
			after.hooks.PreCompact.every((entry: { hooks: { command: string }[] }) =>
				(entry.hooks ?? []).every((h) => !h.command.includes(HOOK_COMMAND_MARKER)),
			),
		).toBe(true);
	});

	it("refuses on parse failure", async () => {
		fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true });
		fs.writeFileSync(getSettingsPath(), "{ broken");
		await expect(uninstallHooks({ yes: true })).rejects.toThrow(/parse/i);
	});
});
