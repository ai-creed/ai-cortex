// src/lib/memory/cli/extractor-log.ts
import { readManifest } from "../extract.js";

export type ExtractorLogCliCtx = { repoKey: string };

export async function runMemoryExtractorLog(
	args: string[],
	ctx: ExtractorLogCliCtx,
): Promise<number> {
	const sessionId = args[0];
	if (!sessionId) {
		process.stderr.write("usage: ai-cortex memory extractor-log <sessionId>\n");
		return 2;
	}
	const m = await readManifest(ctx.repoKey, sessionId);
	if (!m) {
		process.stderr.write(`no extractor manifest for session=${sessionId}\n`);
		return 1;
	}
	process.stdout.write(JSON.stringify(m, null, 2) + "\n");
	return 0;
}
