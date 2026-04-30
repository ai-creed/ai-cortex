// src/lib/memory/cli/extract.ts
import { extractFromSession } from "../extract.js";

export type ExtractCliCtx = { repoKey: string };

function flagValue(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

export async function runMemoryExtract(
	args: string[],
	ctx: ExtractCliCtx,
): Promise<number> {
	const sessionId = flagValue(args, "--session");
	if (!sessionId) {
		process.stderr.write(
			"usage: ai-cortex memory extract --session <id> [--re-extract]\n",
		);
		return 2;
	}
	const allowReExtract = args.includes("--re-extract");
	const m = await extractFromSession(ctx.repoKey, sessionId, {
		allowReExtract,
	});
	process.stdout.write(
		`sessionId:         ${m.sessionId}\n` +
			`candidatesCreated: ${m.candidatesCreated}\n` +
			`evidenceAppended:  ${m.evidenceAppended}\n` +
			`rejectedCount:     ${m.rejectedCandidates.length}\n`,
	);
	return 0;
}
