// benchmarks/reporters/json.ts
import fs from "node:fs";
import type { SuiteReport } from "../lib/types.js";

export function writeJsonReport(report: SuiteReport, outputPath: string): void {
	fs.writeFileSync(outputPath, JSON.stringify(report, null, "\t") + "\n");
	process.stderr.write(`JSON report written to ${outputPath}\n`);
}
