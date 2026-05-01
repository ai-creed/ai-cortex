// src/lib/memory/cli/sweep.ts
import { sweepAging } from "../aging.js";

export async function runMemorySweep(
  args: string[],
  opts: { repoKey: string; stdout?: { write: (s: string) => boolean } },
): Promise<number> {
  const dryRun = args.includes("--dry-run");
  const out = opts.stdout ?? process.stdout;
  try {
    const report = await sweepAging(opts.repoKey, { dryRun });
    const trashedCount = report.actionsApplied.filter(
      (a) => a.newStatus === "trashed",
    ).length;
    const purgedCount = report.actionsApplied.filter(
      (a) => a.newStatus === "purged",
    ).length;
    const prefix = dryRun ? "dry-run: " : "";
    out.write(
      `${prefix}${trashedCount} trashed, ${purgedCount} purged (${report.actionsApplied.length} total)\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      (err instanceof Error ? err.message : String(err)) + "\n",
    );
    return 1;
  }
}
