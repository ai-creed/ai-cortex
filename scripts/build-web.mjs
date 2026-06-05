// scripts/build-web.mjs
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const outDir = path.resolve("dist/web/graph");
fs.mkdirSync(outDir, { recursive: true });

for (const [entry, out] of [
	["web/graph/main.ts", "app.js"], // 2D (Cosmograph)
	["web/graph/main3d.ts", "app3d.js"], // 3D (3d-force-graph / Three.js)
]) {
	await build({
		entryPoints: [entry],
		bundle: true,
		format: "esm",
		target: "es2022",
		outfile: path.join(outDir, out),
		logLevel: "info",
	});
}

for (const f of ["index.html", "overlay.css", "3d.html"]) {
	fs.copyFileSync(path.join("web/graph", f), path.join(outDir, f));
}
console.log("web bundle built:", outDir);
