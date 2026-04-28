// src/lib/call-graph.ts
import fs from "node:fs";
import path from "node:path";
import { adapterForFile } from "./adapters/index.js";
import { ensureAdapters } from "./adapters/ensure.js";
import type { RawCallSite, ImportBinding } from "./lang-adapter.js";
import type { CallEdge, FunctionNode, ImportEdge } from "./models.js";

const TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const C_FAMILY_EXTS = new Set([
  ".c", ".cpp", ".cc", ".cxx", ".c++",
  ".h", ".hpp", ".hh", ".hxx", ".h++",
]);

function langOf(filePath: string): "ts" | "cfamily" | "other" {
  const ext = path.extname(filePath);
  if (TS_EXTS.has(ext)) return "ts";
  if (C_FAMILY_EXTS.has(ext)) return "cfamily";
  return "other";
}

export function stripTsExt(value: string): string {
	return value.replace(/\.(ts|tsx|js|jsx)$/u, "");
}

function resolveSpecifier(fromSpecifier: string, callerFile: string): string {
	return path.normalize(path.join(path.dirname(callerFile), fromSpecifier)).replace(/\\/g, "/");
}

function findTargetFile(
	normalizedSpecifier: string,
	allFiles: Map<string, FunctionNode[]>,
	callerLang: "ts" | "cfamily" | "other",
): string | null {
	if (callerLang === "ts") {
		const stripped = stripTsExt(normalizedSpecifier);
		for (const file of allFiles.keys()) {
			if (stripTsExt(file) === stripped) return file;
		}
		for (const file of allFiles.keys()) {
			if (stripTsExt(file) === `${stripped}/index`) return file;
		}
		return null;
	}
	if (callerLang === "cfamily") {
		if (allFiles.has(normalizedSpecifier)) return normalizedSpecifier;
		const baseName = path.basename(normalizedSpecifier);
		const matches: string[] = [];
		for (const file of allFiles.keys()) {
			if (path.basename(file) === baseName) matches.push(file);
		}
		if (matches.length === 1) return matches[0];
		return null;
	}
	return null;
}

function pickUnique(
	fns: FunctionNode[] | undefined,
): FunctionNode | null {
	if (!fns) return null;
	const live = fns.filter((f) => !f.isDeclarationOnly);
	if (live.length === 1) return live[0];
	return null;
}

export function resolveCallSites(
	rawCalls: RawCallSite[],
	allFunctions: FunctionNode[],
	bindingsByFile: Map<string, ImportBinding[]>,
	includesByFile: Map<string, ImportEdge[]>,
): CallEdge[] {
	const funcsByFile = new Map<string, Map<string, FunctionNode[]>>();
	for (const fn of allFunctions) {
		let fileMap = funcsByFile.get(fn.file);
		if (!fileMap) { fileMap = new Map(); funcsByFile.set(fn.file, fileMap); }
		const list = fileMap.get(fn.qualifiedName) ?? [];
		list.push(fn);
		fileMap.set(fn.qualifiedName, list);
	}

	const allFileNodes = new Map<string, FunctionNode[]>();
	for (const fn of allFunctions) {
		const list = allFileNodes.get(fn.file) ?? [];
		list.push(fn);
		allFileNodes.set(fn.file, list);
	}

	const edges: CallEdge[] = [];

	for (const raw of rawCalls) {
		const fromKey = `${raw.callerFile}::${raw.callerQualifiedName}`;
		const bindings = bindingsByFile.get(raw.callerFile) ?? [];
		let resolved = false;

		const dotIndex = raw.rawCallee.indexOf(".");
		if (dotIndex !== -1) {
			const receiver = raw.rawCallee.slice(0, dotIndex);
			const member = raw.rawCallee.slice(dotIndex + 1);
			const binding = bindings.find((b) => b.localName === receiver);
			if (binding) {
				const specifier = resolveSpecifier(binding.fromSpecifier, raw.callerFile);
				const targetFile = findTargetFile(specifier, allFileNodes, langOf(raw.callerFile));
				if (targetFile && binding.bindingKind === "namespace") {
					const targetFunc = pickUnique(funcsByFile.get(targetFile)?.get(member));
					if (targetFunc) {
						edges.push({ from: fromKey, to: `${targetFile}::${targetFunc.qualifiedName}`, kind: raw.kind });
						resolved = true;
					}
				}
			}
			if (!resolved) {
				edges.push({ from: fromKey, to: `::${member}`, kind: raw.kind });
				resolved = true;
			}
		}

		if (resolved) continue;

		const binding = bindings.find((b) => b.localName === raw.rawCallee);
		if (binding) {
			const specifier = resolveSpecifier(binding.fromSpecifier, raw.callerFile);
			const targetFile = findTargetFile(specifier, allFileNodes, langOf(raw.callerFile));
			if (targetFile) {
				if (binding.bindingKind === "default") {
					const defaultFunc = allFunctions.find((f) => f.file === targetFile && f.isDefaultExport);
					if (defaultFunc) {
						edges.push({ from: fromKey, to: `${targetFile}::${defaultFunc.qualifiedName}`, kind: raw.kind });
						resolved = true;
					}
				} else {
					const targetFunc = pickUnique(funcsByFile.get(targetFile)?.get(binding.importedName));
					if (targetFunc) {
						edges.push({ from: fromKey, to: `${targetFile}::${targetFunc.qualifiedName}`, kind: raw.kind });
						resolved = true;
					}
				}
			}
		}

		if (resolved) continue;

		const sameFile = funcsByFile.get(raw.callerFile);
		if (sameFile) {
			const match = pickUnique(sameFile.get(raw.rawCallee));
			if (match) {
				edges.push({ from: fromKey, to: `${raw.callerFile}::${match.qualifiedName}`, kind: raw.kind });
				continue;
			}
		}

		edges.push({ from: fromKey, to: `::${raw.rawCallee}`, kind: raw.kind });
	}

	return edges;
}

export type ExtractResult = {
	rawCalls: RawCallSite[];
	functions: FunctionNode[];
	bindingsByFile: Map<string, ImportBinding[]>;
};

export async function extractCallGraphRaw(
	worktreePath: string,
	filePaths: string[],
): Promise<ExtractResult> {
	await ensureAdapters();
	const allFunctions: FunctionNode[] = [];
	const allRawCalls: RawCallSite[] = [];
	const bindingsByFile = new Map<string, ImportBinding[]>();

	for (const filePath of filePaths) {
		const adapter = adapterForFile(filePath);
		if (!adapter) continue;

		let source: string;
		try {
			source = fs.readFileSync(path.join(worktreePath, filePath), "utf8");
		} catch {
			continue;
		}

		try {
			const result = adapter.extractFile(source, filePath);
			allFunctions.push(...result.functions);
			allRawCalls.push(...result.rawCalls);
			if (result.importBindings.length > 0) {
				bindingsByFile.set(filePath, result.importBindings);
			}
		} catch {
			continue;
		}
	}

	return { rawCalls: allRawCalls, functions: allFunctions, bindingsByFile };
}

export async function extractCallGraph(
	worktreePath: string,
	filePaths: string[],
): Promise<{ calls: CallEdge[]; functions: FunctionNode[] }> {
	const { rawCalls, functions, bindingsByFile } = await extractCallGraphRaw(
		worktreePath,
		filePaths,
	);
	// first-index callers don't need cross-include resolution beyond what
	// bindings provide; pass an empty includes map. The incremental indexer
	// builds a real includesByFile.
	const calls = resolveCallSites(rawCalls, functions, bindingsByFile, new Map());
	return { calls, functions };
}
