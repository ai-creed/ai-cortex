// src/lib/memory/cli/merge.ts
import fs from "node:fs/promises";
import { openLifecycle, mergeMemories } from "../lifecycle.js";

type MergeArgs = { srcId: string; dstId: string; bodyFile: string };

function parseMergeArgs(args: string[]): MergeArgs {
	const positional: string[] = [];
	let bodyFile: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--body-file" && args[i + 1]) {
			bodyFile = args[++i];
			continue;
		}
		if (!a.startsWith("--")) {
			positional.push(a);
			continue;
		}
	}
	if (positional.length < 2) throw new Error("required: <src-id> <dst-id>");
	if (!bodyFile) throw new Error("required: --body-file");
	return { srcId: positional[0], dstId: positional[1], bodyFile };
}

async function readBody(
	bodyFile: string,
	stdin: NodeJS.ReadStream = process.stdin,
): Promise<string> {
	if (bodyFile === "-") {
		const chunks: Buffer[] = [];
		for await (const chunk of stdin) {
			chunks.push(
				Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string),
			);
		}
		return Buffer.concat(chunks).toString("utf8");
	}
	return fs.readFile(bodyFile, "utf8");
}

export async function runMemoryMerge(
	args: string[],
	opts: {
		repoKey: string;
		stdin?: NodeJS.ReadStream;
		stdout?: NodeJS.WriteStream;
	} = { repoKey: "" },
): Promise<number> {
	try {
		const parsed = parseMergeArgs(args);
		const mergedBody = await readBody(parsed.bodyFile, opts.stdin);
		const lc = await openLifecycle(opts.repoKey, { agentId: "cli-user" });
		try {
			await mergeMemories(lc, parsed.srcId, parsed.dstId, mergedBody);
			(opts.stdout ?? process.stdout).write("ok\n");
			return 0;
		} finally {
			lc.close();
		}
	} catch (err) {
		process.stderr.write(
			(err instanceof Error ? err.message : String(err)) + "\n",
		);
		return 1;
	}
}
