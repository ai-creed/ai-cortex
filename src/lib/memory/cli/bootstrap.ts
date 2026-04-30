// src/lib/memory/cli/bootstrap.ts
import { bootstrapFromHistory } from "../bootstrap.js";

export type BootstrapCliCtx = { repoKey: string };

function flagValue(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

function flagBool(args: string[], name: string): boolean {
	return args.includes(name);
}

export async function runMemoryBootstrap(
	args: string[],
	ctx: BootstrapCliCtx,
): Promise<number> {
	const limitSessions = (() => {
		const v = flagValue(args, "--limit-sessions");
		return v ? Number(v) : undefined;
	})();
	const minConfidence = (() => {
		const v = flagValue(args, "--min-confidence");
		return v ? Number(v) : undefined;
	})();
	const allowReExtract = flagBool(args, "--re-extract");

	const r = await bootstrapFromHistory(ctx.repoKey, {
		limitSessions,
		minConfidence,
		allowReExtract,
	});

	process.stdout.write(
		`sessionsProcessed: ${r.sessionsProcessed}\n` +
		`candidatesCreated: ${r.candidatesCreated}\n` +
		`evidenceAppended: ${r.evidenceAppended}\n` +
		`rejectedCount:     ${r.rejectedCount}\n` +
		`errors:            ${r.errors.length}\n`,
	);
	if (r.errors.length > 0) {
		for (const e of r.errors) process.stderr.write(`  ${e.sessionId}: ${e.message}\n`);
	}
	return 0;
}
