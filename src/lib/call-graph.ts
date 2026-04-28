// src/lib/call-graph.ts
import fs from "node:fs";
import path from "node:path";
import { adapterForFile } from "./adapters/index.js";
import { ensureAdapters } from "./adapters/ensure.js";
import type { RawCallSite, ImportBinding } from "./lang-adapter.js";
import type { CallEdge, FunctionNode } from "./models.js";

function stripKnownExt(value: string): string {
	return value.replace(/\.(ts|tsx|js|jsx)$/u, "");
}

function resolveSpecifier(fromSpecifier: string, callerFile: string): string {
	return path.normalize(path.join(path.dirname(callerFile), fromSpecifier)).replace(/\\/g, "/");
}

function findTargetFile(normalizedSpecifier: string, allFiles: Map<string, FunctionNode[]>): string | null {
	const strippedSpecifier = stripKnownExt(normalizedSpecifier);
	for (const file of allFiles.keys()) {
		if (stripKnownExt(file) === strippedSpecifier) return file;
	}
	for (const file of allFiles.keys()) {
		if (stripKnownExt(file) === `${strippedSpecifier}/index`) return file;
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
				const targetFile = findTargetFile(specifier, allFileNodes);
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
			const targetFile = findTargetFile(specifier, allFileNodes);
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

export async function extractCallGraph(
	worktreePath: string,
	filePaths: string[],
): Promise<{ calls: CallEdge[]; functions: FunctionNode[] }> {
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

	const calls = resolveCallSites(allRawCalls, allFunctions, bindingsByFile);
	return { calls, functions: allFunctions };
}
