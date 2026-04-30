import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export const HOOK_COMMAND_MARKER = "ai-cortex history capture";

const HOOK_EVENTS = ["PreCompact", "SessionEnd"] as const;
const CODEX_HOOK_EVENTS = ["UserPromptSubmit", "Stop"] as const;
const HOOK_COMMAND = HOOK_COMMAND_MARKER;

type InnerHook = { type: "command"; command: string };
type Hook = { matcher: string; hooks: InnerHook[] };
type Settings = {
	hooks?: Partial<Record<string, Hook[]>>;
	[k: string]: unknown;
};

export function getSettingsPath(): string {
	return path.join(os.homedir(), ".claude", "settings.json");
}

export function getCodexConfigPath(): string {
	return path.join(os.homedir(), ".codex", "config.toml");
}

export type InstallOpts = {
	yes: boolean;
	/** Test-only: bypass readline, supply the answer directly. */
	answerForTest?: "y" | "n";
};

export async function installHooks(
	opts: InstallOpts,
): Promise<"installed" | "no-op" | "aborted"> {
	const settingsPath = getSettingsPath();
	const codexPath = getCodexConfigPath();
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
	fs.mkdirSync(path.dirname(codexPath), { recursive: true });

	const before = fs.existsSync(settingsPath)
		? fs.readFileSync(settingsPath, "utf8")
		: "";
	const settings = parseOrThrow(before, settingsPath);
	const codexBefore = fs.existsSync(codexPath)
		? fs.readFileSync(codexPath, "utf8")
		: "";

	const next = applyInstall(settings);
	const afterText = JSON.stringify(next, null, 2) + "\n";
	const codexAfterText = applyCodexInstall(codexBefore);
	const beforeText = before.length > 0 ? before : "(no existing file)\n";

	if (
		afterText.trim() === before.trim() &&
		codexAfterText.trim() === codexBefore.trim()
	) {
		// Already installed; no-op, no output.
		return "no-op";
	}

	if (!opts.yes) {
		printDiff("~/.claude/settings.json", beforeText, afterText);
		printDiff(
			"~/.codex/config.toml",
			codexBefore.length > 0 ? codexBefore : "(no existing file)\n",
			codexAfterText,
		);
		const proceed = await confirm(
			"Apply these changes to Claude and Codex hook config? [y/N] ",
			opts.answerForTest,
		);
		if (!proceed) return "aborted";
	}

	if (before.length > 0) {
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		fs.copyFileSync(
			settingsPath,
			path.join(path.dirname(settingsPath), `settings.json.bak.${ts}`),
		);
	}
	if (codexBefore.length > 0 && codexAfterText.trim() !== codexBefore.trim()) {
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		fs.copyFileSync(
			codexPath,
			path.join(path.dirname(codexPath), `config.toml.bak.${ts}`),
		);
	}
	writeAtomic(settingsPath, afterText);
	writeAtomic(codexPath, codexAfterText);
	return "installed";
}

export async function uninstallHooks(
	opts: InstallOpts,
): Promise<"uninstalled" | "no-op" | "aborted"> {
	const settingsPath = getSettingsPath();
	const codexPath = getCodexConfigPath();
	if (!fs.existsSync(settingsPath) && !fs.existsSync(codexPath)) return "no-op";

	const before = fs.existsSync(settingsPath)
		? fs.readFileSync(settingsPath, "utf8")
		: "";
	const settings = parseOrThrow(before, settingsPath);
	const next = applyUninstall(settings);
	const afterText = JSON.stringify(next, null, 2) + "\n";
	const codexBefore = fs.existsSync(codexPath)
		? fs.readFileSync(codexPath, "utf8")
		: "";
	const codexAfterText = applyCodexUninstall(codexBefore);

	if (
		afterText.trim() === before.trim() &&
		codexAfterText.trim() === codexBefore.trim()
	)
		return "no-op";

	if (!opts.yes) {
		printDiff("~/.claude/settings.json", before, afterText);
		printDiff("~/.codex/config.toml", codexBefore, codexAfterText);
		const proceed = await confirm(
			"Apply these changes? [y/N] ",
			opts.answerForTest,
		);
		if (!proceed) return "aborted";
	}

	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	if (before.length > 0 && afterText.trim() !== before.trim()) {
		fs.copyFileSync(
			settingsPath,
			path.join(path.dirname(settingsPath), `settings.json.bak.${ts}`),
		);
		writeAtomic(settingsPath, afterText);
	}
	if (codexBefore.length > 0 && codexAfterText.trim() !== codexBefore.trim()) {
		fs.copyFileSync(
			codexPath,
			path.join(path.dirname(codexPath), `config.toml.bak.${ts}`),
		);
		writeAtomic(codexPath, codexAfterText);
	}
	return "uninstalled";
}

function parseOrThrow(text: string, settingsPath: string): Settings {
	if (text.length === 0) return {};
	try {
		return JSON.parse(text) as Settings;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(
			`refusing to write ${settingsPath}: failed to parse existing JSON: ${msg}`,
		);
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
			list.push({
				matcher: "",
				hooks: [{ type: "command", command: HOOK_COMMAND }],
			});
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
				hooks: (entry.hooks ?? []).filter(
					(h) => !h.command.includes(HOOK_COMMAND_MARKER),
				),
			}))
			.filter((entry) => entry.hooks.length > 0);
		next.hooks![evt] = list;
	}
	return next;
}

function applyCodexInstall(text: string): string {
	let next = text.trimEnd();
	for (const evt of CODEX_HOOK_EVENTS) {
		if (codexEventHasMarker(next, evt)) continue;
		next += `${next.length > 0 ? "\n\n" : ""}[[hooks.${evt}]]\n`;
		next += `matcher = ""\n`;
		next += `[[hooks.${evt}.hooks]]\n`;
		next += `type = "command"\n`;
		next += `command = "${HOOK_COMMAND}"\n`;
	}
	return next + "\n";
}

function codexEventHasMarker(text: string, evt: string): boolean {
	const groups = codexHookGroups(text);
	return groups.some(
		(group) =>
			group.event === evt &&
			group.lines.join("\n").includes(HOOK_COMMAND_MARKER),
	);
}

function applyCodexUninstall(text: string): string {
	const groups = codexHookGroups(text);
	if (groups.length === 0) return text;
	const out: string[] = [];
	let cursor = 0;
	for (const group of groups) {
		out.push(...text.split("\n").slice(cursor, group.start));
		const kept = removeCodexMarkerHooks(group.lines);
		if (kept.length > 0) out.push(...kept);
		cursor = group.end;
	}
	out.push(...text.split("\n").slice(cursor));
	return (
		out
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trimEnd() + "\n"
	);
}

function codexHookGroups(
	text: string,
): Array<{ event: string; start: number; end: number; lines: string[] }> {
	const lines = text.split("\n");
	const groups: Array<{
		event: string;
		start: number;
		end: number;
		lines: string[];
	}> = [];
	for (let i = 0; i < lines.length; i += 1) {
		const m = /^\[\[hooks\.([A-Za-z]+)\]\]$/.exec(lines[i]);
		if (!m) continue;
		let end = lines.length;
		for (let j = i + 1; j < lines.length; j += 1) {
			if (/^\[\[hooks\.[A-Za-z]+\]\]$/.test(lines[j])) {
				end = j;
				break;
			}
		}
		groups.push({ event: m[1], start: i, end, lines: lines.slice(i, end) });
		i = end - 1;
	}
	return groups;
}

function removeCodexMarkerHooks(lines: string[]): string[] {
	const hookStarts: number[] = [];
	for (let i = 0; i < lines.length; i += 1) {
		if (/^\[\[hooks\.[A-Za-z]+\.hooks\]\]$/.test(lines[i])) hookStarts.push(i);
	}
	if (hookStarts.length === 0)
		return lines.join("\n").includes(HOOK_COMMAND_MARKER) ? [] : lines;
	const prefix = lines.slice(0, hookStarts[0]);
	const keptHooks: string[] = [];
	for (let i = 0; i < hookStarts.length; i += 1) {
		const start = hookStarts[i];
		const end = hookStarts[i + 1] ?? lines.length;
		const hook = lines.slice(start, end);
		if (!hook.join("\n").includes(HOOK_COMMAND_MARKER)) keptHooks.push(...hook);
	}
	return keptHooks.length === 0 ? [] : [...prefix, ...keptHooks];
}

function writeAtomic(filePath: string, text: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmp = filePath + ".tmp";
	fs.writeFileSync(tmp, text);
	fs.renameSync(tmp, filePath);
}

function printDiff(label: string, before: string, after: string): void {
	const a = before.split("\n");
	const b = after.split("\n");
	const beforeSet = new Set(a);
	const afterSet = new Set(b);
	process.stdout.write(`--- ${label} (current)\n`);
	process.stdout.write(`+++ ${label} (proposed)\n`);
	for (const line of a) {
		if (!afterSet.has(line)) process.stdout.write(`- ${line}\n`);
	}
	for (const line of b) {
		if (!beforeSet.has(line)) process.stdout.write(`+ ${line}\n`);
	}
}

async function confirm(
	prompt: string,
	answerForTest?: "y" | "n",
): Promise<boolean> {
	if (answerForTest !== undefined) return answerForTest === "y";
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	const answer: string = await new Promise((resolve) =>
		rl.question(prompt, resolve),
	);
	rl.close();
	return answer.trim().toLowerCase() === "y";
}
