// src/lib/memory/cli/list.ts
import { openRetrieve, listMemories } from "../retrieve.js";

type ListArgs = {
	types: string[];
	statuses: string[];
	scopeFile?: string;
	limit?: number;
	json: boolean;
};

function parseListArgs(args: string[]): ListArgs {
	const types: string[] = [];
	const statuses: string[] = [];
	let scopeFile: string | undefined;
	let limit: number | undefined;
	let json = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--json") {
			json = true;
			continue;
		}
		if (a === "--type" && args[i + 1]) {
			types.push(args[++i]);
			continue;
		}
		if (a === "--status" && args[i + 1]) {
			statuses.push(args[++i]);
			continue;
		}
		if (a === "--scope-file" && args[i + 1]) {
			scopeFile = args[++i];
			continue;
		}
		if (a === "--limit" && args[i + 1]) {
			limit = Number(args[++i]);
			continue;
		}
	}
	return { types, statuses, scopeFile, limit, json };
}

export async function runMemoryList(
	args: string[],
	opts: {
		repoKey: string;
		stdout?: NodeJS.WriteStream;
	} = { repoKey: "" },
): Promise<number> {
	try {
		const parsed = parseListArgs(args);
		const rh = openRetrieve(opts.repoKey);
		try {
			const items = listMemories(rh, {
				type: parsed.types.length ? parsed.types : undefined,
				status: parsed.statuses.length ? parsed.statuses : undefined,
				scopeFile: parsed.scopeFile,
				limit: parsed.limit,
			});
			const out = opts.stdout ?? process.stdout;
			if (parsed.json) {
				out.write(JSON.stringify(items, null, 2) + "\n");
			} else {
				for (const item of items) {
					out.write(
						`${item.id}  [${item.type}/${item.status}] ${item.title}\n`,
					);
				}
			}
			return 0;
		} finally {
			rh.close();
		}
	} catch (err) {
		process.stderr.write(
			(err instanceof Error ? err.message : String(err)) + "\n",
		);
		return 1;
	}
}
