import { registerAdapter, clearAdapters } from "./index.js";

let ensurePromise: Promise<void> | null = null;

export async function ensureAdapters(): Promise<void> {
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    // Init once before parallel factories: prevents concurrent Parser.init() calls
    // from each creating a separate Emscripten instance and racing over the shared
    // C handle, which on Linux leaves grammar data-relocs unapplied (version 0).
    const { Parser } = await import("web-tree-sitter");
    await Parser.init();

    const { createTypescriptAdapter } = await import("./typescript.js");
    const { createCAdapter, createCppAdapter } = await import("./cfamily.js");
    const { createPythonAdapter } = await import("./python.js");
    const [ts, c, cpp, py] = await Promise.all([
      createTypescriptAdapter(),
      createCAdapter(),
      createCppAdapter(),
      createPythonAdapter(),
    ]);
    registerAdapter(ts);
    registerAdapter(c);
    registerAdapter(cpp);
    registerAdapter(py);
  })();
  return ensurePromise;
}

// Test helper — resets the registration cache so tests can re-init.
export function resetEnsureAdapters(): void {
  ensurePromise = null;
  clearAdapters();
}
