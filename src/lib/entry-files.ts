// src/lib/entry-files.ts
import fs from "node:fs";
import path from "node:path";
import type { PackageMeta } from "./models.js";

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.promises.access(filePath);
		return true;
	} catch {
		return false;
	}
}

const FRAMEWORK_CONVENTIONS: Record<
	NonNullable<PackageMeta["framework"]>,
	string[]
> = {
	electron: ["electron/main/index.ts", "src/main.ts", "src/main.tsx"],
	next: [
		"src/app/layout.tsx",
		"src/app/page.tsx",
		"pages/_app.tsx",
		"pages/index.tsx",
	],
	vite: ["src/main.ts", "src/main.tsx", "src/index.ts"],
	node: ["src/index.ts", "src/main.ts", "index.ts"],
};

const COMMON_FALLBACKS = [
	"src/index.ts",
	"src/main.ts",
	"src/main.tsx",
	"index.ts",
	"src/index.tsx",
];

export async function readPackageMeta(
	worktreePath: string,
): Promise<PackageMeta> {
	const pkgPath = path.join(worktreePath, "package.json");
	const fallback: PackageMeta = {
		name: path.basename(worktreePath),
		version: "0.0.0",
		framework: null,
	};

	if (!(await fileExists(pkgPath))) return fallback;

	try {
		const raw = JSON.parse(
			await fs.promises.readFile(pkgPath, "utf8"),
		) as Record<string, unknown>;
		const deps: Record<string, string> = {
			...((raw.dependencies as Record<string, string>) ?? {}),
			...((raw.devDependencies as Record<string, string>) ?? {}),
		};
		return {
			name: typeof raw.name === "string" ? raw.name : fallback.name,
			version: typeof raw.version === "string" ? raw.version : "0.0.0",
			main: typeof raw.main === "string" ? raw.main : undefined,
			module: typeof raw.module === "string" ? raw.module : undefined,
			framework: detectFramework(deps),
		};
	} catch {
		return fallback;
	}
}

function detectFramework(
	deps: Record<string, string>,
): PackageMeta["framework"] {
	if ("electron" in deps) return "electron";
	if ("next" in deps) return "next";
	if ("vite" in deps) return "vite";
	return null;
}

export function pickEntryFiles(
	filePaths: string[],
	packageMeta: PackageMeta,
): string[] {
	const fileSet = new Set(filePaths);
	const candidates: string[] = [];

	for (const field of [packageMeta.main, packageMeta.module]) {
		if (field && !field.startsWith("dist/") && fileSet.has(field)) {
			candidates.push(field);
		}
	}

	if (packageMeta.framework) {
		for (const p of FRAMEWORK_CONVENTIONS[packageMeta.framework]) {
			if (fileSet.has(p)) candidates.push(p);
		}
	}

	for (const p of COMMON_FALLBACKS) {
		if (fileSet.has(p)) candidates.push(p);
	}

	return [...new Set(candidates)].slice(0, 8);
}
