// src/lib/call-graph.ts
import fs from "node:fs";
import path from "node:path";
import { adapterForFile } from "./adapters/index.js";
import { ensureAdapters } from "./adapters/ensure.js";
import { extractImports } from "./import-graph.js";
import type { RawCallSite, ImportBinding } from "./lang-adapter.js";
import type { CallEdge, FunctionNode, ImportEdge } from "./models.js";

const TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const C_FAMILY_EXTS = new Set([
  ".c", ".cpp", ".cc", ".cxx", ".c++",
  ".h", ".hpp", ".hh", ".hxx", ".h++",
]);
const H_EXTS = new Set([".h", ".hh", ".hpp", ".hxx", ".h++"]);
const SRC_EXTS = [".cpp", ".cc", ".cxx", ".c++", ".c"];

function langOf(filePath: string): "ts" | "cfamily" | "python" | "other" {
  const ext = path.extname(filePath);
  if (TS_EXTS.has(ext)) return "ts";
  if (C_FAMILY_EXTS.has(ext)) return "cfamily";
  if (ext === ".py") return "python";
  return "other";
}

export function stripTsExt(value: string): string {
	return value.replace(/\.(ts|tsx|js|jsx)$/u, "");
}

export function resolvePythonTargetFile(
	fromSpecifier: string,
	callerFile: string,
	allFileNodes: Map<string, FunctionNode[]>,
	includesByFile: Map<string, ImportEdge[]>,
): string | null {
	const specPy = fromSpecifier + ".py";
	const specInit = fromSpecifier + "/__init__.py";
	// Use import-graph edges (already fully resolved by resolveSite) to find target.
	// The suffix match handles src-layout projects where edge.to = "src/pkg/utils.py"
	// but fromSpecifier = "pkg/utils".
	const edges = includesByFile.get(callerFile) ?? [];
	const edge = edges.find(
		(e) =>
			e.to === specPy ||
			e.to === specInit ||
			e.to.endsWith("/" + specPy) ||
			e.to.endsWith("/" + specInit),
	);
	if (edge) return edge.to;
	// Fallback: direct probe for flat-layout cases with no import edge
	if (allFileNodes.has(specPy)) return specPy;
	if (allFileNodes.has(specInit)) return specInit;
	return null;
}

function resolveSpecifier(fromSpecifier: string, callerFile: string): string {
	return path.normalize(path.join(path.dirname(callerFile), fromSpecifier)).replace(/\\/g, "/");
}

function findTargetFile(
	normalizedSpecifier: string,
	allFiles: Map<string, FunctionNode[]>,
	callerLang: "ts" | "cfamily" | "python" | "other",
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
	requireExported = false,
): FunctionNode | null {
	if (!fns) return null;
	const live = fns.filter((f) => !f.isDeclarationOnly && (!requireExported || f.exported));
	if (live.length === 1) return live[0];
	return null;
}

function companionSourceFiles(headerPath: string, known: Map<string, unknown>): string[] {
	const ext = path.extname(headerPath);
	if (!H_EXTS.has(ext)) return [];
	const base = headerPath.slice(0, -ext.length);
	return SRC_EXTS.map((e) => `${base}${e}`).filter((p) => known.has(p));
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
				let targetFile: string | null;
				if (langOf(raw.callerFile) === "python") {
					targetFile = resolvePythonTargetFile(
						binding.fromSpecifier, raw.callerFile, allFileNodes, includesByFile,
					);
				} else {
					const specifier = resolveSpecifier(binding.fromSpecifier, raw.callerFile);
					targetFile = findTargetFile(specifier, allFileNodes, langOf(raw.callerFile));
				}
				if (targetFile && binding.bindingKind === "namespace") {
					const targetFunc = pickUnique(funcsByFile.get(targetFile)?.get(member));
					if (targetFunc) {
						edges.push({ from: fromKey, to: `${targetFile}::${targetFunc.qualifiedName}`, kind: raw.kind });
						resolved = true;
					}
				}
			}
			if (!resolved) {
				// Try full qualified name in same file before falling back to ::member.
				// Handles self.method() → ClassName.method where rawCallee = "ClassName.method".
				const sameFileQual = pickUnique(
					funcsByFile.get(raw.callerFile)?.get(raw.rawCallee),
				);
				if (sameFileQual) {
					edges.push({
						from: fromKey,
						to: `${raw.callerFile}::${sameFileQual.qualifiedName}`,
						kind: raw.kind,
					});
					resolved = true;
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
			let targetFile: string | null;
			if (langOf(raw.callerFile) === "python") {
				targetFile = resolvePythonTargetFile(
					binding.fromSpecifier, raw.callerFile, allFileNodes, includesByFile,
				);
			} else {
				const specifier = resolveSpecifier(binding.fromSpecifier, raw.callerFile);
				targetFile = findTargetFile(specifier, allFileNodes, langOf(raw.callerFile));
			}
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

		// C/C++ include-based lookup: check directly-included files for a live definition
		if (langOf(raw.callerFile) === "cfamily") {
			const includes = includesByFile.get(raw.callerFile);
			if (includes) {
				outer: for (const inc of includes) {
					const incFile = inc.to;
					const match = pickUnique(funcsByFile.get(incFile)?.get(raw.rawCallee), true);
					if (match) {
						edges.push({ from: fromKey, to: `${incFile}::${match.qualifiedName}`, kind: raw.kind });
						resolved = true;
						break;
					}
					for (const companion of companionSourceFiles(incFile, funcsByFile)) {
						const compMatch = pickUnique(funcsByFile.get(companion)?.get(raw.rawCallee), true);
						if (compMatch) {
							edges.push({ from: fromKey, to: `${companion}::${compMatch.qualifiedName}`, kind: raw.kind });
							resolved = true;
							break outer;
						}
					}
				}
			}
			if (resolved) continue;
		}

		// Repo-wide unique-name fallback for C/C++ callers only
		if (!resolved && langOf(raw.callerFile) === "cfamily") {
			const liveDefs = allFunctions.filter(
				(f) =>
					f.qualifiedName === raw.rawCallee &&
					!f.isDeclarationOnly &&
					f.exported &&
					langOf(f.file) === "cfamily",
			);
			if (liveDefs.length === 1) {
				edges.push({ from: fromKey, to: `${liveDefs[0].file}::${liveDefs[0].qualifiedName}`, kind: raw.kind });
				resolved = true;
			}
		}
		if (resolved) continue;

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
	const importEdges = await extractImports(worktreePath, filePaths, filePaths);
	const includesByFile = new Map<string, ImportEdge[]>();
	for (const edge of importEdges) {
		const list = includesByFile.get(edge.from) ?? [];
		list.push(edge);
		includesByFile.set(edge.from, list);
	}
	const calls = resolveCallSites(rawCalls, functions, bindingsByFile, includesByFile);
	return { calls, functions };
}
