import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"benchmarks/eval/fixtures/**",
			".worktrees/**",
		],
		setupFiles: ["./tests/helpers/mock-embed-provider.ts"],
	},
});
