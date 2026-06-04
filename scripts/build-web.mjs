// scripts/build-web.mjs
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const outDir = path.resolve("dist/web/graph");
fs.mkdirSync(outDir, { recursive: true });

await build({
	entryPoints: ["web/graph/main.ts"],
	bundle: true,
	format: "esm",
	target: "es2022",
	outfile: path.join(outDir, "app.js"),
	logLevel: "info",
});

for (const f of ["index.html", "overlay.css"]) {
	fs.copyFileSync(path.join("web/graph", f), path.join(outDir, f));
}
console.log("web bundle built:", outDir);
