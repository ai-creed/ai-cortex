// src/lib/memory/cli/pin.ts
import { openLifecycle, pinMemory, unpinMemory } from "../lifecycle.js";

type PinArgs = { id: string; force: boolean };
type UnpinArgs = { id: string };

function parsePinArgs(args: string[]): PinArgs {
	let id: string | undefined;
	let force = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--force") { force = true; continue; }
		if (!a.startsWith("--") && !id) { id = a; continue; }
	}
	if (!id) throw new Error("required: <id>");
	return { id, force };
}

function parseUnpinArgs(args: string[]): UnpinArgs {
	let id: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (!a.startsWith("--") && !id) { id = a; continue; }
	}
	if (!id) throw new Error("required: <id>");
	return { id };
}

export async function runMemoryPin(args: string[], opts: {
	repoKey: string;
	stdout?: NodeJS.WriteStream;
} = { repoKey: "" }): Promise<number> {
	try {
		const parsed = parsePinArgs(args);
		const lc = await openLifecycle(opts.repoKey, { agentId: "cli-user" });
		try {
			await pinMemory(lc, parsed.id, { force: parsed.force });
			(opts.stdout ?? process.stdout).write("ok\n");
			return 0;
		} finally {
			lc.close();
		}
	} catch (err) {
		process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
		return 1;
	}
}

export async function runMemoryUnpin(args: string[], opts: {
	repoKey: string;
	stdout?: NodeJS.WriteStream;
} = { repoKey: "" }): Promise<number> {
	try {
		const parsed = parseUnpinArgs(args);
		const lc = await openLifecycle(opts.repoKey, { agentId: "cli-user" });
		try {
			await unpinMemory(lc, parsed.id);
			(opts.stdout ?? process.stdout).write("ok\n");
			return 0;
		} finally {
			lc.close();
		}
	} catch (err) {
		process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
		return 1;
	}
}
