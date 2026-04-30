// src/lib/memory/cli/unlink.ts
import { openLifecycle, unlinkMemories } from "../lifecycle.js";
import type { MemoryEdgeType } from "../types.js";

const VALID_REL_TYPES: MemoryEdgeType[] = [
	"supports",
	"contradicts",
	"refines",
	"depends_on",
];

type UnlinkArgs = { srcId: string; dstId: string; relType: MemoryEdgeType };

function parseUnlinkArgs(args: string[]): UnlinkArgs {
	const positional: string[] = [];
	let relType: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--type" && args[i + 1]) {
			relType = args[++i];
			continue;
		}
		if (!a.startsWith("--")) {
			positional.push(a);
			continue;
		}
	}
	if (positional.length < 2) throw new Error("required: <src-id> <dst-id>");
	if (!relType) throw new Error("required: --type");
	if (!VALID_REL_TYPES.includes(relType as MemoryEdgeType)) {
		throw new Error(`--type must be one of: ${VALID_REL_TYPES.join(", ")}`);
	}
	return {
		srcId: positional[0],
		dstId: positional[1],
		relType: relType as MemoryEdgeType,
	};
}

export async function runMemoryUnlink(
	args: string[],
	opts: {
		repoKey: string;
		stdout?: NodeJS.WriteStream;
	} = { repoKey: "" },
): Promise<number> {
	try {
		const parsed = parseUnlinkArgs(args);
		const lc = await openLifecycle(opts.repoKey, { agentId: "cli-user" });
		try {
			await unlinkMemories(lc, parsed.srcId, parsed.dstId, parsed.relType);
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
