import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export const HOOK_COMMAND_MARKER = "ai-cortex history capture";

const HOOK_EVENTS = ["PreCompact", "SessionEnd"] as const;
const HOOK_COMMAND = `${HOOK_COMMAND_MARKER} --session $CLAUDE_SESSION_ID`;

type InnerHook = { type: "command"; command: string };
type Hook = { matcher: string; hooks: InnerHook[] };
type Settings = { hooks?: Partial<Record<string, Hook[]>>; [k: string]: unknown };

export function getSettingsPath(): string {
	return path.join(os.homedir(), ".claude", "settings.json");
}

export type InstallOpts = {
	yes: boolean;
	/** Test-only: bypass readline, supply the answer directly. */
	answerForTest?: "y" | "n";
};

export async function installHooks(opts: InstallOpts): Promise<"installed" | "no-op" | "aborted"> {
	const settingsPath = getSettingsPath();
	const dir = path.dirname(settingsPath);
	fs.mkdirSync(dir, { recursive: true });

	const before = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : "";
	const settings = parseOrThrow(before, settingsPath);

	const next = applyInstall(settings);
	const afterText = JSON.stringify(next, null, 2) + "\n";
	const beforeText = before.length > 0 ? before : "(no existing file)\n";

	if (afterText.trim() === before.trim()) {
		// Already installed; no-op, no output.
		return "no-op";
	}

	if (!opts.yes) {
		printDiff(beforeText, afterText);
		const proceed = await confirm("Apply these changes to ~/.claude/settings.json? [y/N] ", opts.answerForTest);
		if (!proceed) return "aborted";
	}

	if (before.length > 0) {
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		fs.copyFileSync(settingsPath, path.join(dir, `settings.json.bak.${ts}`));
	}
	const tmp = settingsPath + ".tmp";
	fs.writeFileSync(tmp, afterText);
	fs.renameSync(tmp, settingsPath);
	return "installed";
}

export async function uninstallHooks(opts: InstallOpts): Promise<"uninstalled" | "no-op" | "aborted"> {
	const settingsPath = getSettingsPath();
	if (!fs.existsSync(settingsPath)) return "no-op";
	const dir = path.dirname(settingsPath);

	const before = fs.readFileSync(settingsPath, "utf8");
	const settings = parseOrThrow(before, settingsPath);
	const next = applyUninstall(settings);
	const afterText = JSON.stringify(next, null, 2) + "\n";

	if (afterText.trim() === before.trim()) return "no-op";

	if (!opts.yes) {
		printDiff(before, afterText);
		const proceed = await confirm("Apply these changes? [y/N] ", opts.answerForTest);
		if (!proceed) return "aborted";
	}

	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	fs.copyFileSync(settingsPath, path.join(dir, `settings.json.bak.${ts}`));
	const tmp = settingsPath + ".tmp";
	fs.writeFileSync(tmp, afterText);
	fs.renameSync(tmp, settingsPath);
	return "uninstalled";
}

function parseOrThrow(text: string, settingsPath: string): Settings {
	if (text.length === 0) return {};
	try {
		return JSON.parse(text) as Settings;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`refusing to write ${settingsPath}: failed to parse existing JSON: ${msg}`);
	}
}

function applyInstall(s: Settings): Settings {
	const next: Settings = { ...s, hooks: { ...(s.hooks ?? {}) } };
	for (const evt of HOOK_EVENTS) {
		const list = ((next.hooks![evt] ?? []) as Hook[]).slice();
		const alreadyInstalled = list.some((entry) =>
			(entry.hooks ?? []).some((h) => h.command.includes(HOOK_COMMAND_MARKER)),
		);
		if (!alreadyInstalled) {
			list.push({ matcher: "", hooks: [{ type: "command", command: HOOK_COMMAND }] });
		}
		next.hooks![evt] = list;
	}
	return next;
}

function applyUninstall(s: Settings): Settings {
	const next: Settings = { ...s, hooks: { ...(s.hooks ?? {}) } };
	for (const evt of HOOK_EVENTS) {
		const list = ((next.hooks![evt] ?? []) as Hook[])
			.map((entry) => ({
				...entry,
				hooks: (entry.hooks ?? []).filter((h) => !h.command.includes(HOOK_COMMAND_MARKER)),
			}))
			.filter((entry) => entry.hooks.length > 0);
		next.hooks![evt] = list;
	}
	return next;
}

function printDiff(before: string, after: string): void {
	const a = before.split("\n");
	const b = after.split("\n");
	const beforeSet = new Set(a);
	const afterSet = new Set(b);
	process.stdout.write("--- ~/.claude/settings.json (current)\n");
	process.stdout.write("+++ ~/.claude/settings.json (proposed)\n");
	for (const line of a) {
		if (!afterSet.has(line)) process.stdout.write(`- ${line}\n`);
	}
	for (const line of b) {
		if (!beforeSet.has(line)) process.stdout.write(`+ ${line}\n`);
	}
}

async function confirm(prompt: string, answerForTest?: "y" | "n"): Promise<boolean> {
	if (answerForTest !== undefined) return answerForTest === "y";
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const answer: string = await new Promise((resolve) => rl.question(prompt, resolve));
	rl.close();
	return answer.trim().toLowerCase() === "y";
}
