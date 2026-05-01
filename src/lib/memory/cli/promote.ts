// src/lib/memory/cli/promote.ts
import { openLifecycle, promoteToGlobal, GLOBAL_REPO_KEY } from "../lifecycle.js";

export async function runMemoryPromote(
  args: string[],
  opts: {
    repoKey: string;
    stdout?: { write: (s: string) => boolean };
  },
): Promise<number> {
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    process.stderr.write("required: <id>\n");
    return 1;
  }
  const out = opts.stdout ?? process.stdout;
  try {
    // Reconcile global store before any write to it — CLI bypasses the MCP
    // reconcile layer, so we call reconcileStore directly here.
    const { reconcileStore } = await import("../reconcile.js");
    await reconcileStore(GLOBAL_REPO_KEY, "cli-promote");
    const lc = await openLifecycle(opts.repoKey, { agentId: "cli-user" });
    try {
      const globalId = await promoteToGlobal(lc, id);
      out.write(`${globalId}\n`);
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
