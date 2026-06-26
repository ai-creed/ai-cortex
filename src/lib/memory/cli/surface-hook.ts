// src/lib/memory/cli/surface-hook.ts
import path from "node:path";
import { Readable } from "node:stream";
import { resolveRepoIdentity } from "../../repo-identity.js";
import { openRetrieve } from "../retrieve.js";
import { matchSurfaceMemories, type SurfacePointer } from "../surface-core.js";
import { evaluateLedger } from "../surface-ledger.js";
import { parseApplyPatchPaths } from "../apply-patch-paths.js";
import { loadMemoryConfig, DEFAULT_CONFIG } from "../config.js";

const DEADLINE_MS = 250;

type HookInput = {
	session_id?: string;
	cwd?: string;
	tool_name?: string;
	tool_input?: { file_path?: string; command?: string };
};

type RunOpts = {
	stdin?: Readable | NodeJS.ReadStream;
	stdout?: NodeJS.WriteStream | { write: (s: string) => boolean };
	now?: () => number;
};

/**
 * Emit the PreToolUse allow response. `permissionDecision: "allow"` is a
 * Claude Code field — Codex *rejects* it ("unsupported permissionDecision")
 * and fails the hook, which would fire on every Codex apply_patch. So it is
 * emitted only when we positively identify a Claude edit tool (`decision`);
 * every other path (Codex, unknown harness, parse failure) omits it. Absence
 * means "proceed normally" on both harnesses, so the edit is never blocked.
 */
function allow(
	stdout: NonNullable<RunOpts["stdout"]>,
	opts: { decision?: boolean; additionalContext?: string } = {},
): void {
	const hookSpecificOutput: Record<string, unknown> = {
		hookEventName: "PreToolUse",
	};
	if (opts.decision) hookSpecificOutput.permissionDecision = "allow";
	if (opts.additionalContext)
		hookSpecificOutput.additionalContext = opts.additionalContext;
	stdout.write(JSON.stringify({ hookSpecificOutput }) + "\n");
}

/** Edit tools reported only by Claude Code; Codex always reports apply_patch. */
function isClaudeEditTool(name: string | undefined): boolean {
	return name === "Edit" || name === "Write" || name === "MultiEdit";
}

async function readAll(stream: Readable | NodeJS.ReadStream): Promise<string> {
	let s = "";
	for await (const chunk of stream) s += chunk;
	return s;
}

function extractRawPaths(input: HookInput): string[] {
	const name = input.tool_name;
	const ti = input.tool_input ?? {};
	if (name === "Edit" || name === "Write" || name === "MultiEdit") {
		return typeof ti.file_path === "string" && ti.file_path.length > 0
			? [ti.file_path]
			: [];
	}
	if (name === "apply_patch") {
		return typeof ti.command === "string" ? parseApplyPatchPaths(ti.command) : [];
	}
	return [];
}

/** Make an absolute or relative tool path repo-relative to worktreePath. */
function toRepoRel(worktreePath: string, p: string): string | null {
	const abs = path.isAbsolute(p) ? p : path.resolve(worktreePath, p);
	const rel = path.relative(worktreePath, abs);
	if (rel.length === 0 || rel.startsWith("..") || path.isAbsolute(rel)) return null;
	return rel.split(path.sep).join("/");
}

function pushToGroup<V>(map: Map<string, V[]>, key: string, value: V): void {
	const arr = map.get(key);
	if (arr) arr.push(value);
	else map.set(key, [value]);
}

function buildContext(pointers: SurfacePointer[]): string {
	const byFile = new Map<string, SurfacePointer[]>();
	for (const p of pointers) pushToGroup(byFile, p.path, p);
	const lines: string[] = [];
	for (const [file, ps] of byFile) {
		lines.push(
			`ai-cortex: ${file} has memories scoped to it you have not seen this session.`,
		);
		for (const p of ps) lines.push(`- [${p.id}] ${p.title} (${p.type})`);
	}
	lines.push(
		"Evaluate each against THIS edit. For any that apply, call get_memory(id) before editing.",
		"Surfaced ≠ relevant — do NOT get_memory ones that do not apply.",
	);
	return lines.join("\n");
}

/**
 * PreToolUse hook entrypoint. Reads the harness hook JSON on stdin and
 * prints an `allow` (+ optional `additionalContext`) JSON. ALWAYS resolves
 * with 0 and ALWAYS prints an allow — every failure path is silent-allow
 * (spec §8). Never blocks an edit.
 */
export async function runSurfaceHook(opts: RunOpts = {}): Promise<number> {
	const stdout = opts.stdout ?? process.stdout;
	const now = opts.now ?? Date.now;
	const start = now();
	try {
		const raw = await readAll(opts.stdin ?? process.stdin);
		let input: HookInput;
		try {
			input = JSON.parse(raw) as HookInput;
		} catch {
			// Harness unknown on parse failure → omit permissionDecision.
			allow(stdout);
			return 0;
		}
		const decision = isClaudeEditTool(input.tool_name);

		if (process.env.AI_CORTEX_SURFACE === "0") {
			allow(stdout, { decision });
			return 0;
		}

		const rawPaths = extractRawPaths(input);
		if (rawPaths.length === 0 || typeof input.cwd !== "string") {
			allow(stdout, { decision });
			return 0;
		}

		let repoKey: string;
		let worktreePath: string;
		try {
			({ repoKey, worktreePath } = resolveRepoIdentity(input.cwd));
		} catch {
			allow(stdout, { decision });
			return 0;
		}
		if (now() - start > DEADLINE_MS) {
			allow(stdout, { decision });
			return 0;
		}

		const relPaths: string[] = [];
		for (const p of rawPaths) {
			const rel = toRepoRel(worktreePath, p);
			if (rel) relPaths.push(rel);
		}
		if (relPaths.length === 0) {
			allow(stdout, { decision });
			return 0;
		}

		let pointers: SurfacePointer[] = [];
		const rh = openRetrieve(repoKey);
		try {
			let cfg = DEFAULT_CONFIG;
			try {
				cfg = await loadMemoryConfig(repoKey);
			} catch {
				/* best-effort: fall back to defaults, never block the edit */
			}
			pointers = matchSurfaceMemories(rh, relPaths, {
				tier2: true,
				tier2MinScore: cfg.surface.tier2MinScore,
			});
		} finally {
			rh.close();
		}
		if (pointers.length === 0 || now() - start > DEADLINE_MS) {
			allow(stdout, { decision });
			return 0;
		}

		const perFile = new Map<string, string[]>();
		for (const p of pointers) pushToGroup(perFile, p.path, p.id);
		const { fresh } = evaluateLedger(
			repoKey,
			input.session_id ?? "_nosession",
			perFile,
		);
		const shown = pointers.filter((p) => fresh.get(p.path)?.has(p.id));
		if (shown.length > 0) {
			try {
				const { appendSurfaceEvent } = await import(
					"../../stats/surface-events.js"
				);
				appendSurfaceEvent(repoKey, {
					ts: Date.now(),
					session_id:
						typeof input.session_id === "string" ? input.session_id : null,
					memoryIds: shown.map((p) => p.id),
					tiers: shown.map((p) => p.tier ?? "file"),
					count: shown.length,
				});
			} catch {
				/* never block the edit on telemetry */
			}
		}
		allow(stdout, {
			decision,
			additionalContext: shown.length > 0 ? buildContext(shown) : undefined,
		});
		return 0;
	} catch {
		// Inviolable: never block an edit.
		try {
			allow(stdout);
		} catch {
			/* stdout itself failed; nothing more we can do */
		}
		return 0;
	}
}
