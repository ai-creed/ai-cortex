// tests/integration/history-hook.test.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRepoIdentity } from "../../src/lib/repo-identity.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "dist", "src", "cli.js");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "history", "sample.jsonl");

let home: string;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-history-hook-"));
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
});

function runCli(args: string[], opts: { extraEnv?: Record<string, string>; cwd?: string; input?: string } = {}): string {
	return execFileSync("node", [CLI, ...args], {
		env: { ...process.env, HOME: home, ...(opts.extraEnv ?? {}) },
		cwd: opts.cwd,
		encoding: "utf8",
		...(opts.input !== undefined ? { input: opts.input } : {}),
	});
}

function setupGitRepo(): string {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ai-cortex-history-hook-repo-"));
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
	execFileSync("git", ["-C", repo, "config", "user.email", "test@test.invalid"]);
	execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
	execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-q", "-m", "init"]);
	return repo;
}

function placeTranscriptForHookSim(repoCwd: string, sessionId: string): void {
	// Use realpath so encoding matches what process.cwd() returns inside the CLI subprocess.
	const real = fs.realpathSync(repoCwd);
	const encoded = real.replace(/\//g, "-");
	const dir = path.join(home, ".claude", "projects", encoded);
	fs.mkdirSync(dir, { recursive: true });
	fs.copyFileSync(FIXTURE, path.join(dir, `${sessionId}.jsonl`));
}

describe("hook install simulation", () => {
	it("install-hooks writes settings.json with PreCompact + SessionEnd entries", () => {
		runCli(["history", "install-hooks", "--yes"]);
		const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
		const entries = [
			...(settings.hooks.PreCompact ?? []),
			...(settings.hooks.SessionEnd ?? []),
		] as Array<{ hooks: Array<{ command: string }> }>;
		const cmds = entries.flatMap((entry) => (entry.hooks ?? []).map((h) => h.command));
		expect(cmds.some((c) => c.includes("ai-cortex history capture"))).toBe(true);
	});

	it("installed command captures via stdin hook JSON + git repoKey auto-discovery", () => {
		// 1. Install the hook to read what the command actually contains.
		runCli(["history", "install-hooks", "--yes"]);
		const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
		const installedCmd = settings.hooks.PreCompact[0].hooks[0].command as string;

		// 2. Set up a real git repo (cwd) and the transcript at the auto-discovery path.
		const repoCwdRaw = setupGitRepo();
		// Resolve symlinks so path encoding matches what process.cwd() returns inside the CLI subprocess.
		const repoCwd = fs.realpathSync(repoCwdRaw);
		const sessionId = "hooked-sess";
		placeTranscriptForHookSim(repoCwd, sessionId);

		// 3. Run the installed command from repo cwd, piping the Claude Code hook JSON payload via stdin.
		//    Claude Code passes { session_id, transcript_path, cwd, ... } — no env vars.
		const argv = installedCmd.split(/\s+/).slice(1); // ["history", "capture"]
		const hookPayload = JSON.stringify({ session_id: sessionId });
		const out = runCli(argv, { cwd: repoCwd, input: hookPayload });
		expect(JSON.parse(out)).toEqual({ continue: true });

		// 4. Verify capture wrote to the git-identity-derived cache path.
		const repoKey = resolveRepoIdentity(repoCwd).repoKey;
		const sessionJson = path.join(home, ".cache", "ai-cortex", "v1", repoKey, "history", "sessions", sessionId, "session.json");
		expect(fs.existsSync(sessionJson)).toBe(true);

		fs.rmSync(repoCwdRaw, { recursive: true, force: true });
	});

	it("history off blocks hook capture (CLI returns disabled status)", () => {
		runCli(["history", "off"]);
		const repoCwdRaw = setupGitRepo();
		// Resolve symlinks so path encoding matches what process.cwd() returns inside the CLI subprocess.
		const repoCwd = fs.realpathSync(repoCwdRaw);
		const sessionId = "off-sess";
		placeTranscriptForHookSim(repoCwd, sessionId);

		const out = runCli(["history", "capture", "--session", sessionId], { cwd: repoCwd });
		expect(out).toContain('"status":"disabled"');

		const repoKey = resolveRepoIdentity(repoCwd).repoKey;
		const sessionJson = path.join(home, ".cache", "ai-cortex", "v1", repoKey, "history", "sessions", sessionId, "session.json");
		expect(fs.existsSync(sessionJson)).toBe(false);

		fs.rmSync(repoCwdRaw, { recursive: true, force: true });
	});

	it("history off returns Codex-safe JSON when capture is invoked as a stdin hook", () => {
		runCli(["history", "off"]);
		const repoCwdRaw = setupGitRepo();
		const repoCwd = fs.realpathSync(repoCwdRaw);
		const out = runCli(["history", "capture"], {
			cwd: repoCwd,
			input: JSON.stringify({ session_id: "off-sess" }),
		});

		expect(JSON.parse(out)).toEqual({ continue: true });

		fs.rmSync(repoCwdRaw, { recursive: true, force: true });
	});

	it("uninstall-hooks removes our entries but leaves others", () => {
		fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
		const thirdParty = { matcher: "", hooks: [{ type: "command", command: "third-party-hook" }] };
		fs.writeFileSync(
			path.join(home, ".claude", "settings.json"),
			JSON.stringify({ hooks: { PreCompact: [thirdParty] } }),
		);
		runCli(["history", "install-hooks", "--yes"]);
		runCli(["history", "uninstall-hooks", "--yes"]);
		const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
		expect(settings.hooks.PreCompact).toEqual([thirdParty]);
	});
});
