import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"benchmarks/eval/fixtures/**",
			".worktrees/**",
		],
		setupFiles: [
			"./tests/helpers/isolate-cache-home.ts",
			"./tests/helpers/mock-embed-provider.ts",
			"./tests/helpers/isolate-session-id.ts",
		],
		// Several integration/CLI suites operate on the real git worktree and
		// real cache via `process.cwd()` (e.g. index.test, diff-files,
		// surface-hook, blast-radius, sqlite-store) and the bench smoke test
		// briefly writes an untracked file into it. Running test FILES in
		// parallel races them on shared on-disk state and oversubscribes CPU,
		// producing flaky timeouts/assertion failures (reproducible on the
		// pre-existing baseline). The suite is correct and green when files run
		// sequentially, so pin file execution to one worker for deterministic
		// runs. Within-file test execution is unaffected.
		fileParallelism: false,
	},
});
