// src/lib/memory/cli/get.ts
import { openRetrieve, getMemory } from "../retrieve.js";

type GetArgs = { id: string; json: boolean };

function parseGetArgs(args: string[]): GetArgs {
	let id: string | undefined;
	let json = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--json") {
			json = true;
			continue;
		}
		if (!a.startsWith("--") && !id) {
			id = a;
			continue;
		}
	}
	if (!id) throw new Error("required: <id>");
	return { id, json };
}

export async function runMemoryGet(
	args: string[],
	opts: {
		repoKey: string;
		stdout?: NodeJS.WriteStream;
	} = { repoKey: "" },
): Promise<number> {
	try {
		const parsed = parseGetArgs(args);
		const rh = openRetrieve(opts.repoKey);
		try {
			const record = await getMemory(rh, parsed.id);
			const out = opts.stdout ?? process.stdout;
			if (parsed.json) {
				out.write(JSON.stringify(record, null, 2) + "\n");
			} else {
				out.write(record.body + "\n");
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
