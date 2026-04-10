import { coldScanBaseline } from "./spike/cold-scan-baseline.js";
import { buildCache } from "./spike/build-cache.js";
import { coldOrient } from "./spike/cold-orient.js";
import { measure } from "./spike/measure.js";
import { runPhase0 } from "./spike/run-phase-0.js";

const [, , command = "rehydrate", ...args] = process.argv;

if (command === "index") {
	const repoPath = args[0] ?? process.cwd();
	const result = await measure("index", () => buildCache(repoPath));
	process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} else if (command === "rehydrate") {
	const refresh = args.includes("--refresh");
	const repoPath = args.find(arg => arg !== "--refresh") ?? process.cwd();
	const result = await runPhase0(repoPath, { refresh, writeToStdout: false });
	process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} else if (command === "baseline") {
	const repoPath = args[0] ?? process.cwd();
	const result = await measure("cold-baseline", () => coldScanBaseline(repoPath));
	process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} else if (command === "cold-orient") {
	const repoPath = args[0] ?? process.cwd();
	const result = await measure("cold-orient", () => coldOrient(repoPath));
	process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} else {
	process.stderr.write(`Unknown command: ${command}\n`);
	process.exit(1);
}
