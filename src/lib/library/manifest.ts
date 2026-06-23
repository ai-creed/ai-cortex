// src/lib/library/manifest.ts
import fs from "node:fs";
import { manifestPath, sourceDir } from "./paths.js";
import type { Manifest } from "./types.js";

export function readManifest(sourceId: string): Manifest | null {
	try {
		return JSON.parse(
			fs.readFileSync(manifestPath(sourceId), "utf8"),
		) as Manifest;
	} catch {
		return null;
	}
}

export function writeManifest(sourceId: string, manifest: Manifest): void {
	fs.mkdirSync(sourceDir(sourceId), { recursive: true });
	const tmp = manifestPath(sourceId) + ".tmp";
	fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf8");
	fs.renameSync(tmp, manifestPath(sourceId));
}
