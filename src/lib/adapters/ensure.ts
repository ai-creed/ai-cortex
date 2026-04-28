// src/lib/adapters/ensure.ts
import { registerAdapter, clearAdapters } from "./index.js";

let ensurePromise: Promise<void> | null = null;

export async function ensureAdapters(): Promise<void> {
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    const { createTypescriptAdapter } = await import("./typescript.js");
    const { createCAdapter, createCppAdapter } = await import("./cfamily.js");
    const [ts, c, cpp] = await Promise.all([
      createTypescriptAdapter(),
      createCAdapter(),
      createCppAdapter(),
    ]);
    registerAdapter(ts);
    registerAdapter(c);
    registerAdapter(cpp);
  })();
  return ensurePromise;
}

// Test helper — resets the registration cache so tests can re-init.
export function resetEnsureAdapters(): void {
  ensurePromise = null;
  clearAdapters();
}
