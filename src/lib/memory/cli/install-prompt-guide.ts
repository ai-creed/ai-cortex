// src/lib/memory/cli/install-prompt-guide.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyInstall, applyUninstall } from "../prompt-guide.js";

type Scope = "global" | "project";
type AgentTarget = "claude" | "codex" | "all";

type CliArgs = { scope: Scope; agent: AgentTarget; yes: boolean };

function parseArgs(args: string[]): CliArgs {
	let scope: Scope = "global";
	let agent: AgentTarget = "all";
	let yes = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--scope" && args[i + 1] !== undefined) {
			const v = args[++i]!;
			if (v !== "global" && v !== "project") {
				throw new Error(`--scope must be global|project (got ${v})`);
			}
			scope = v;
			continue;
		}
		if (a === "--agent" && args[i + 1] !== undefined) {
			const v = args[++i]!;
			if (v !== "claude" && v !== "codex" && v !== "all") {
				throw new Error(`--agent must be claude|codex|all (got ${v})`);
			}
			agent = v;
			continue;
		}
		if (a === "--yes" || a === "-y") {
			yes = true;
			continue;
		}
	}
	return { scope, agent, yes };
}

type CliOpts = {
	cwd?: string;
	home?: string;
	stdout?: { write: (s: string) => boolean };
};

function resolveTargets(
	scope: Scope,
	agent: AgentTarget,
	cwd: string,
	home: string,
): string[] {
	const claudePath =
		scope === "global"
			? path.join(home, ".claude", "CLAUDE.md")
			: path.join(cwd, "CLAUDE.md");
	const codexPath =
		scope === "global"
			? path.join(home, ".codex", "AGENTS.md")
			: path.join(cwd, "AGENTS.md");
	const targets: string[] = [];
	if (agent === "claude" || agent === "all") targets.push(claudePath);
	if (agent === "codex" || agent === "all") targets.push(codexPath);
	return targets;
}

export async function runMemoryInstallPromptGuide(
	args: string[],
	opts: CliOpts = {},
): Promise<number> {
	let parsed: CliArgs;
	try {
		parsed = parseArgs(args);
	} catch (err) {
		process.stderr.write(
			`ai-cortex: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		return 1;
	}
	if (parsed.scope === "project" && !parsed.yes) {
		process.stderr.write(
			"ai-cortex: --scope project modifies your repo's CLAUDE.md/AGENTS.md (typically tracked by git). Pass --yes to confirm.\n",
		);
		return 1;
	}
	const cwd = opts.cwd ?? process.cwd();
	const home = opts.home ?? os.homedir();
	const out = opts.stdout ?? process.stdout;
	const targets = resolveTargets(parsed.scope, parsed.agent, cwd, home);
	for (const target of targets) {
		const before = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
		const after = applyInstall(before);
		if (after === before) {
			out.write(`- ${target}: already up to date\n`);
			continue;
		}
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, after);
		out.write(`✓ ${before === "" ? "wrote" : "updated"} ${target}\n`);
	}
	return 0;
}

export async function runMemoryUninstallPromptGuide(
	args: string[],
	opts: CliOpts = {},
): Promise<number> {
	let parsed: CliArgs;
	try {
		parsed = parseArgs(args);
	} catch (err) {
		process.stderr.write(
			`ai-cortex: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		return 1;
	}
	if (parsed.scope === "project" && !parsed.yes) {
		process.stderr.write(
			"ai-cortex: --scope project modifies your repo's CLAUDE.md/AGENTS.md (typically tracked by git). Pass --yes to confirm.\n",
		);
		return 1;
	}
	const cwd = opts.cwd ?? process.cwd();
	const home = opts.home ?? os.homedir();
	const out = opts.stdout ?? process.stdout;
	const targets = resolveTargets(parsed.scope, parsed.agent, cwd, home);
	for (const target of targets) {
		if (!fs.existsSync(target)) {
			out.write(`- ${target}: file does not exist, skipped\n`);
			continue;
		}
		const before = fs.readFileSync(target, "utf8");
		const after = applyUninstall(before);
		if (after === before) {
			out.write(`- ${target}: no block present, left untouched\n`);
			continue;
		}
		fs.writeFileSync(target, after);
		out.write(`✓ removed block from ${target}\n`);
	}
	return 0;
}
