// src/lib/memory/cli/update.ts
import fs from "node:fs/promises";
import { openLifecycle, updateMemory } from "../lifecycle.js";

type UpdateArgs = { id: string; title?: string; bodyFile?: string; reason?: string };

function parseUpdateArgs(args: string[]): UpdateArgs {
	let id: string | undefined;
	let title: string | undefined;
	let bodyFile: string | undefined;
	let reason: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--title" && args[i + 1]) { title = args[++i]; continue; }
		if (a === "--body-file" && args[i + 1]) { bodyFile = args[++i]; continue; }
		if (a === "--reason" && args[i + 1]) { reason = args[++i]; continue; }
		if (!a.startsWith("--") && !id) { id = a; continue; }
	}
	if (!id) throw new Error("required: <id>");
	if (!title && !bodyFile) throw new Error("required: --title or --body-file");
	return { id, title, bodyFile, reason };
}

async function readBody(bodyFile: string, stdin: NodeJS.ReadStream = process.stdin): Promise<string> {
	if (bodyFile === "-") {
		const chunks: Buffer[] = [];
		for await (const chunk of stdin) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
		}
		return Buffer.concat(chunks).toString("utf8");
	}
	return fs.readFile(bodyFile, "utf8");
}

export async function runMemoryUpdate(args: string[], opts: {
	repoKey: string;
	stdin?: NodeJS.ReadStream;
	stdout?: NodeJS.WriteStream;
} = { repoKey: "" }): Promise<number> {
	try {
		const parsed = parseUpdateArgs(args);
		const body = parsed.bodyFile ? await readBody(parsed.bodyFile, opts.stdin) : undefined;
		const lc = await openLifecycle(opts.repoKey, { agentId: "cli-user" });
		try {
			await updateMemory(lc, parsed.id, { title: parsed.title, body, reason: parsed.reason });
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
