import { coldScanBaseline } from "./spike/cold-scan-baseline.js";
import { measure } from "./spike/measure.js";
import { runPhase0 } from "./spike/run-phase-0.js";

const [, , command = "phase0", repoPath = process.cwd()] = process.argv;

if (command === "phase0") {
	await runPhase0(repoPath);
} else if (command === "baseline") {
	const result = await measure("cold-baseline", () => coldScanBaseline(repoPath));
	process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} else {
	process.stderr.write(`Unknown command: ${command}\n`);
	process.exit(1);
}
