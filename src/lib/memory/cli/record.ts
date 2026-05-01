// src/lib/memory/cli/record.ts
import fs from "node:fs/promises";
import {
	openLifecycle,
	openGlobalLifecycle,
	GLOBAL_REPO_KEY,
	createMemory,
} from "../lifecycle.js";
import { reconcileStore } from "../reconcile.js";

type RecordArgs = {
	type: string;
	title: string;
	bodyFile: string;
	tags: string[];
	scopeFiles: string[];
	source: "explicit" | "extracted";
	confidence?: number;
	globalScope: boolean;
};

function parseRecordArgs(args: string[]): RecordArgs {
	const out: Partial<RecordArgs> & {
		tags: string[];
		scopeFiles: string[];
		source: "explicit" | "extracted";
		globalScope: boolean;
	} = {
		tags: [],
		scopeFiles: [],
		source: "explicit",
		globalScope: false,
	};
	let i = 0;
	while (i < args.length) {
		const a = args[i];
		switch (a) {
			case "--type":
				out.type = args[++i];
				break;
			case "--title":
				out.title = args[++i];
				break;
			case "--body-file":
				out.bodyFile = args[++i];
				break;
			case "--tag":
				out.tags.push(args[++i]);
				break;
			case "--scope-file":
				out.scopeFiles.push(args[++i]);
				break;
			case "--source":
				out.source = args[++i] as "explicit" | "extracted";
				break;
			case "--confidence":
				out.confidence = Number(args[++i]);
				break;
			case "--global-scope":
				out.globalScope = true;
				break;
			default:
				throw new Error(`unknown flag: ${a}`);
		}
		i++;
	}
	if (!out.type) throw new Error("required: --type");
	if (!out.title) throw new Error("required: --title");
	if (!out.bodyFile) throw new Error("required: --body-file");
	return out as RecordArgs;
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

export async function runMemoryRecord(
	args: string[],
	opts: {
		repoKey: string;
		stdin?: NodeJS.ReadStream;
		stdout?: NodeJS.WriteStream;
		agentId?: string;
	} = { repoKey: "" },
): Promise<number> {
	let parsed: RecordArgs;
	try {
		parsed = parseRecordArgs(args);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`memory record: ${msg}\n`);
		return 1;
	}
	const body = await readBody(parsed.bodyFile, opts.stdin);
	if (parsed.globalScope) {
		// CLI bypasses MCP reconcile layer — reconcile global store explicitly.
		await reconcileStore(GLOBAL_REPO_KEY, "cli-record-global");
	}
	const lc = parsed.globalScope
		? await openGlobalLifecycle({ agentId: opts.agentId ?? "cli-user" })
		: await openLifecycle(opts.repoKey, {
				agentId: opts.agentId ?? "cli-user",
			});
	try {
		const id = await createMemory(lc, {
			type: parsed.type,
			title: parsed.title,
			body,
			scope: { files: parsed.scopeFiles, tags: parsed.tags },
			source: parsed.source,
			confidence: parsed.confidence,
		});
		(opts.stdout ?? process.stdout).write(`${id}\n`);
		return 0;
	} finally {
		lc.close();
	}
}
