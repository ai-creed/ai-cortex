// src/lib/call-graph.ts
import { getAdapterForFile, adapterSupports } from "./adapters/index.js";
import { ensureAdapters } from "./adapters/ensure.js";
import { extractImports } from "./import-graph.js";
import { functionsFromSymbols } from "./symbols.js";
import {
	buildReexportTable,
	buildSymbolIndex,
	companionSourceFiles,
	findTargetFile,
	knownFilesFor,
	langOf,
	resolveName,
	resolvePythonTargetFile,
	resolveRefs,
	resolveSpecifier,
} from "./symbol-resolver.js";
import type { RawCallSite, RawRefSite, ImportBinding } from "./lang-adapter.js";
import type {
	CallEdge,
	FunctionNode,
	ImportEdge,
	RefEdge,
	ReexportRow,
	SymbolNode,
} from "./models.js";

export { stripTsExt, resolvePythonTargetFile } from "./symbol-resolver.js";

function pickUnique(
	fns: FunctionNode[] | undefined,
	requireExported = false,
): FunctionNode | null {
	if (!fns) return null;
	const live = fns.filter(
		(f) => !f.isDeclarationOnly && (!requireExported || f.exported),
	);
	if (live.length === 1) return live[0];
	return null;
}

function makeEdge(from: string, to: string, raw: RawCallSite): CallEdge {
	const edge: CallEdge = { from, to, kind: raw.kind };
	if (raw.site) edge.site = raw.site;
	return edge;
}

export function resolveCallSites(
	rawCalls: RawCallSite[],
	allFunctions: FunctionNode[],
	bindingsByFile: Map<string, ImportBinding[]>,
	includesByFile: Map<string, ImportEdge[]>,
	symbols: SymbolNode[] = [],
	reexports: ReexportRow[] = [],
): CallEdge[] {
	const funcsByFile = new Map<string, Map<string, FunctionNode[]>>();
	for (const fn of allFunctions) {
		let fileMap = funcsByFile.get(fn.file);
		if (!fileMap) {
			fileMap = new Map();
			funcsByFile.set(fn.file, fileMap);
		}
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

	const symIdx = buildSymbolIndex(symbols);
	const reexportTable = buildReexportTable(reexports);
	const known = knownFilesFor(symIdx, reexportTable, includesByFile);

	// C/C++: a live exported definition of `name` in a directly-included file
	// or in that header's companion source file.
	const viaIncludes = (callerFile: string, name: string): string | null => {
		for (const inc of includesByFile.get(callerFile) ?? []) {
			const match = pickUnique(funcsByFile.get(inc.to)?.get(name), true);
			if (match) return `${inc.to}::${match.qualifiedName}`;
			for (const companion of companionSourceFiles(inc.to, funcsByFile)) {
				const compMatch = pickUnique(
					funcsByFile.get(companion)?.get(name),
					true,
				);
				if (compMatch) return `${companion}::${compMatch.qualifiedName}`;
			}
		}
		return null;
	};

	const edges: CallEdge[] = [];

	for (const raw of rawCalls) {
		const fromKey = `${raw.callerFile}::${raw.callerQualifiedName}`;
		const bindings = bindingsByFile.get(raw.callerFile) ?? [];

		// Shared resolver first (A5 steps 1 to 4, including aliased re-exports).
		if (symbols.length > 0) {
			const dot = raw.rawCallee.lastIndexOf(".");
			const site =
				dot === -1
					? {
							file: raw.callerFile,
							name: raw.rawCallee,
							enclosingClass: raw.enclosingClass,
						}
					: {
							file: raw.callerFile,
							name: raw.rawCallee.slice(dot + 1),
							receiver: raw.rawCallee.slice(0, dot),
							enclosingClass: raw.enclosingClass,
						};
			const hit = resolveName(
				symIdx,
				site,
				bindings,
				reexportTable,
				includesByFile,
				known,
			);
			if (hit) {
				edges.push(makeEdge(fromKey, hit, raw));
				continue;
			}
		}

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
						binding.fromSpecifier,
						raw.callerFile,
						allFileNodes,
						includesByFile,
					);
				} else {
					const specifier = resolveSpecifier(
						binding.fromSpecifier,
						raw.callerFile,
					);
					targetFile = findTargetFile(
						specifier,
						allFileNodes,
						langOf(raw.callerFile),
					);
				}
				if (targetFile && binding.bindingKind === "namespace") {
					const targetFunc = pickUnique(
						funcsByFile.get(targetFile)?.get(member),
					);
					if (targetFunc) {
						edges.push(
							makeEdge(
								fromKey,
								`${targetFile}::${targetFunc.qualifiedName}`,
								raw,
							),
						);
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
					edges.push(
						makeEdge(
							fromKey,
							`${raw.callerFile}::${sameFileQual.qualifiedName}`,
							raw,
						),
					);
					resolved = true;
				}
			}
			if (!resolved && langOf(raw.callerFile) === "cfamily") {
				// Qualified C++ call (`ns.add`): the full dotted name through includes.
				const hit = viaIncludes(raw.callerFile, raw.rawCallee);
				if (hit) {
					edges.push(makeEdge(fromKey, hit, raw));
					resolved = true;
				}
			}
			if (!resolved) {
				edges.push(makeEdge(fromKey, `::${member}`, raw));
				resolved = true;
			}
		}

		if (resolved) continue;

		const binding = bindings.find((b) => b.localName === raw.rawCallee);
		if (binding) {
			let targetFile: string | null;
			if (langOf(raw.callerFile) === "python") {
				targetFile = resolvePythonTargetFile(
					binding.fromSpecifier,
					raw.callerFile,
					allFileNodes,
					includesByFile,
				);
			} else {
				const specifier = resolveSpecifier(
					binding.fromSpecifier,
					raw.callerFile,
				);
				targetFile = findTargetFile(
					specifier,
					allFileNodes,
					langOf(raw.callerFile),
				);
			}
			if (targetFile) {
				if (binding.bindingKind === "default") {
					const defaultFunc = allFunctions.find(
						(f) => f.file === targetFile && f.isDefaultExport,
					);
					if (defaultFunc) {
						edges.push(
							makeEdge(
								fromKey,
								`${targetFile}::${defaultFunc.qualifiedName}`,
								raw,
							),
						);
						resolved = true;
					}
				} else {
					const targetFunc = pickUnique(
						funcsByFile.get(targetFile)?.get(binding.importedName),
					);
					if (targetFunc) {
						edges.push(
							makeEdge(
								fromKey,
								`${targetFile}::${targetFunc.qualifiedName}`,
								raw,
							),
						);
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
				edges.push(
					makeEdge(fromKey, `${raw.callerFile}::${match.qualifiedName}`, raw),
				);
				continue;
			}
		}

		// C/C++ include-based lookup: check directly-included files for a live definition
		if (langOf(raw.callerFile) === "cfamily") {
			const hit = viaIncludes(raw.callerFile, raw.rawCallee);
			if (hit) {
				edges.push(makeEdge(fromKey, hit, raw));
				continue;
			}
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
				edges.push(
					makeEdge(
						fromKey,
						`${liveDefs[0].file}::${liveDefs[0].qualifiedName}`,
						raw,
					),
				);
				resolved = true;
			}
		}
		if (resolved) continue;

		edges.push(makeEdge(fromKey, `::${raw.rawCallee}`, raw));
	}

	return edges;
}

export type ExtractResult = {
	rawCalls: RawCallSite[];
	rawRefs: RawRefSite[];
	symbols: SymbolNode[];
	functions: FunctionNode[];
	reexports: ReexportRow[];
	bindingsByFile: Map<string, ImportBinding[]>;
};

export async function extractCallGraphRaw(
	worktreePath: string,
	filePaths: string[],
	contentMap?: Map<string, string>,
): Promise<ExtractResult> {
	await ensureAdapters();
	const allSymbols: SymbolNode[] = [];
	const allRawCalls: RawCallSite[] = [];
	const allRawRefs: RawRefSite[] = [];
	const allReexports: ReexportRow[] = [];
	const bindingsByFile = new Map<string, ImportBinding[]>();

	for (const filePath of filePaths) {
		if (!adapterSupports(filePath, "callGraph")) continue;
		const adapter = getAdapterForFile(filePath);
		if (!adapter?.extractCallGraph) continue;

		const content = contentMap?.get(filePath);
		if (contentMap && content === undefined) continue;

		try {
			const result = await adapter.extractCallGraph(
				worktreePath,
				filePath,
				content,
			);
			allSymbols.push(...result.symbols);
			allRawCalls.push(...result.rawCalls);
			allRawRefs.push(...result.rawRefs);
			allReexports.push(...result.reexports);
			if (result.importBindings.length > 0) {
				bindingsByFile.set(filePath, result.importBindings);
			}
		} catch {
			continue;
		}
	}

	return {
		rawCalls: allRawCalls,
		rawRefs: allRawRefs,
		symbols: allSymbols,
		functions: functionsFromSymbols(allSymbols),
		reexports: allReexports,
		bindingsByFile,
	};
}

export async function extractCallGraph(
	worktreePath: string,
	filePaths: string[],
	contentMap?: Map<string, string>,
): Promise<{
	calls: CallEdge[];
	functions: FunctionNode[];
	symbols: SymbolNode[];
	refs: RefEdge[];
	reexports: ReexportRow[];
}> {
	const { rawCalls, rawRefs, functions, symbols, reexports, bindingsByFile } =
		await extractCallGraphRaw(worktreePath, filePaths, contentMap);
	const importEdges = await extractImports(
		worktreePath,
		filePaths,
		filePaths,
		contentMap,
	);
	const includesByFile = new Map<string, ImportEdge[]>();
	for (const edge of importEdges) {
		const list = includesByFile.get(edge.from) ?? [];
		list.push(edge);
		includesByFile.set(edge.from, list);
	}
	const calls = resolveCallSites(
		rawCalls,
		functions,
		bindingsByFile,
		includesByFile,
		symbols,
		reexports,
	);
	const refs = resolveRefs(
		rawRefs,
		symbols,
		bindingsByFile,
		reexports,
		includesByFile,
	);
	return { calls, functions, symbols, refs, reexports };
}
