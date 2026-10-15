// src/lib/adapters/python.ts
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type {
	LanguageAdapter,
	RawCallData,
	RawCallSite,
	RawImportSite,
	ImportBinding,
	RawRefSite,
} from "../lang-adapter.js";
import type { SymbolNode } from "../models.js";
import { functionsFromSymbols, PY_REF_KINDS, PY_SYMBOL_KINDS } from "../symbols.js";
import { rangeFromNode } from "./_range.js";

const require = createRequire(import.meta.url);

let pyParser: import("web-tree-sitter").Parser | null = null;
let initPromise: Promise<void> | null = null;

type SyntaxNode = import("web-tree-sitter").Node;

async function initParser(): Promise<void> {
	if (initPromise) return initPromise;
	initPromise = (async () => {
		const { Parser: TreeSitter, Language } = await import("web-tree-sitter");
		await TreeSitter.init();
		const grammarPath =
			require.resolve("tree-sitter-python/tree-sitter-python.wasm");
		const pyLang = await Language.load(grammarPath);
		pyParser = new TreeSitter();
		pyParser.setLanguage(pyLang);
	})();
	return initPromise;
}

function extractSymbols(root: SyntaxNode, filePath: string): SymbolNode[] {
	const out: SymbolNode[] = [];

	function emit(kind: SymbolNode["kind"], nameNode: SyntaxNode, decl: SyntaxNode, container: string | null): string {
		const qualifiedName = container ? `${container}.${nameNode.text}` : nameNode.text;
		out.push({
			qualifiedName,
			name: nameNode.text,
			file: filePath,
			kind,
			...(container ? { containerQualifiedName: container } : {}),
			exported: true,
			isDefaultExport: false,
			isDeclarationOnly: false,
			range: rangeFromNode(decl),
			nameRange: rangeFromNode(nameNode),
		});
		return qualifiedName;
	}

	function assignmentTargets(left: SyntaxNode): SyntaxNode[] {
		if (left.type === "identifier") return [left];
		if (left.type === "pattern_list" || left.type === "tuple_pattern" || left.type === "list_pattern") {
			return left.namedChildren.flatMap(assignmentTargets);
		}
		return [];
	}

	function walk(node: SyntaxNode, container: string | null): void {
		switch (node.type) {
			case "function_definition": {
				const nameNode = node.childForFieldName("name");
				if (nameNode) emit(container ? "method" : "function", nameNode, node, container);
				return; // bodies are not indexed scope
			}
			case "decorated_definition": {
				const def = node.children.find(
					(c) => c.type === "function_definition" || c.type === "class_definition",
				);
				if (def) walk(def, container);
				return;
			}
			case "class_definition": {
				const nameNode = node.childForFieldName("name");
				if (!nameNode) return;
				const clsQn = emit("class", nameNode, node, container);
				const body = node.childForFieldName("body");
				if (body) for (const child of body.children) walk(child, clsQn);
				return;
			}
			case "expression_statement": {
				if (container !== null) return; // class-body assignments: best effort, not emitted
				const assign = node.namedChildren[0];
				if (assign?.type === "assignment") {
					const left = assign.childForFieldName("left");
					if (left) for (const t of assignmentTargets(left)) emit("variable", t, node, null);
				}
				return;
			}
			default:
				if (container === null) for (const child of node.children) walk(child, container);
		}
	}

	for (const child of root.children) walk(child, null);
	return out;
}

// Dotted class chain (e.g. "Outer.Inner") for the class ancestors of `from`,
// matching the container names extractSymbols emits. Returns null when a
// function_definition ancestor is hit (nested scope, not indexed); returns ""
// at module level.
function classChainOf(from: SyntaxNode | null): string | null {
	const names: string[] = [];
	let p = from;
	while (p && p.type !== "module") {
		if (p.type === "function_definition") return null;
		if (p.type === "class_definition") {
			const n = p.childForFieldName("name")?.text;
			if (!n) return null;
			names.unshift(n);
		}
		p = p.parent;
	}
	return names.join(".");
}

function findEnclosingFunction(
	node: SyntaxNode,
): { name: string; className: string | null } | null {
	let cur: SyntaxNode | null = node.parent;
	while (cur) {
		if (cur.type === "function_definition") {
			const nameNode = cur.childForFieldName("name");
			if (!nameNode) return null;
			// A function_definition ancestor above this def means it is nested:
			// extractSymbols does not index it, so emitting a call edge from it
			// would produce a phantom caller node.
			const chain = classChainOf(cur.parent);
			if (chain === null) return null;
			return { name: nameNode.text, className: chain || null };
		}
		cur = cur.parent;
	}
	return null;
}

function extractRawCalls(root: SyntaxNode, filePath: string): RawCallSite[] {
	const calls: RawCallSite[] = [];

	function walk(node: SyntaxNode): void {
		if (node.type === "call") {
			const fnNode = node.childForFieldName("function");
			if (fnNode) {
				const enclosing = findEnclosingFunction(node);
				if (enclosing) {
					const callerQualifiedName = enclosing.className
						? `${enclosing.className}.${enclosing.name}`
						: enclosing.name;
					let rawCallee: string;
					let kind: RawCallSite["kind"];
					if (fnNode.type === "attribute") {
						const obj = fnNode.childForFieldName("object")?.text ?? "";
						const attr = fnNode.childForFieldName("attribute")?.text ?? "";
						rawCallee = `${obj}.${attr}`;
						kind = "method";
					} else {
						rawCallee = fnNode.text;
						kind = "call";
					}
					calls.push({
						callerQualifiedName,
						callerFile: filePath,
						rawCallee,
						kind,
						site: rangeFromNode(node),
						...(enclosing.className ? { enclosingClass: enclosing.className } : {}),
					});
				}
			}
		}
		for (const child of node.children) walk(child);
	}

	walk(root);
	return calls;
}

function extractRawRefs(root: SyntaxNode, filePath: string): RawRefSite[] {
	const refs: RawRefSite[] = [];

	function ctxOf(node: SyntaxNode): Pick<RawRefSite, "enclosingQualifiedName" | "enclosingClass"> {
		const enc = findEnclosingFunction(node);
		if (enc) {
			return {
				enclosingQualifiedName: enc.className ? `${enc.className}.${enc.name}` : enc.name,
				...(enc.className ? { enclosingClass: enc.className } : {}),
			};
		}
		// class body but outside any method
		const chain = classChainOf(node.parent);
		if (chain) return { enclosingQualifiedName: chain, enclosingClass: chain };
		return {};
	}

	function walk(node: SyntaxNode): void {
		if (node.type === "call") {
			const fnNode = node.childForFieldName("function");
			if (fnNode?.type === "attribute") {
				const obj = fnNode.childForFieldName("object");
				const attr = fnNode.childForFieldName("attribute");
				if (obj && attr) refs.push({ file: filePath, name: attr.text, kind: "call", range: rangeFromNode(attr), receiver: obj.text, ...ctxOf(node) });
			} else if (fnNode?.type === "identifier") {
				refs.push({ file: filePath, name: fnNode.text, kind: "call", range: rangeFromNode(fnNode), ...ctxOf(node) });
			}
		} else if (node.type === "class_definition") {
			const supers = node.childForFieldName("superclasses");
			if (supers) {
				for (const s of supers.namedChildren) {
					if (s.type === "identifier") refs.push({ file: filePath, name: s.text, kind: "extends", range: rangeFromNode(s) });
					else if (s.type === "attribute") {
						const obj = s.childForFieldName("object");
						const attr = s.childForFieldName("attribute");
						if (obj && attr) refs.push({ file: filePath, name: attr.text, kind: "extends", range: rangeFromNode(attr), receiver: obj.text });
					}
				}
			}
		} else if (node.type === "import_from_statement") {
			const modNode = node.children.find((c) => c.type === "relative_import" || c.type === "dotted_name");
			if (modNode) {
				const specifier = moduleSpecifier(modNode, filePath);
				for (const child of node.children) {
					if ((child.type === "dotted_name" || child.type === "identifier") && child !== modNode) {
						refs.push({ file: filePath, name: child.text, kind: "import", range: rangeFromNode(child), specifier, importKind: "named" });
					} else if (child.type === "aliased_import") {
						const nameNode = child.childForFieldName("name");
						const alias = child.childForFieldName("alias")?.text;
						if (nameNode) refs.push({ file: filePath, name: nameNode.text, kind: "import", range: rangeFromNode(nameNode), specifier, importKind: "named", ...(alias ? { alias } : {}) });
					}
				}
			}
			return;
		} else if (node.type === "import_statement") {
			for (const child of node.children) {
				if (child.type === "aliased_import") {
					const nameNode = child.childForFieldName("name");
					const aliasNode = child.childForFieldName("alias");
					if (nameNode && aliasNode) {
						refs.push({ file: filePath, name: aliasNode.text, kind: "import", range: rangeFromNode(aliasNode), specifier: nameNode.text.replace(/\./gu, "/"), importKind: "namespace" });
					}
				}
			}
			return;
		}
		for (const child of node.children) walk(child);
	}

	walk(root);
	refs.sort((a, b) => a.range.line - b.range.line || a.range.column - b.range.column || a.kind.localeCompare(b.kind));
	return refs;
}

// Returns a repo-root-relative slash-separated specifier for both relative and
// absolute Python imports. Used identically for RawImportSite.candidate and
// ImportBinding.fromSpecifier so resolvePythonTargetFile can suffix-match both.
function moduleSpecifier(moduleNameNode: SyntaxNode, filePath: string): string {
	if (moduleNameNode.type === "relative_import") {
		let dots = 0;
		let nameText = "";
		for (const child of moduleNameNode.children) {
			if (child.type === "import_prefix") {
				dots = child.text.length;
			} else if (child.type === "dotted_name") {
				nameText = child.text.replace(/\./gu, "/");
			}
		}
		let base = path.dirname(filePath);
		for (let i = 1; i < dots; i++) base = path.dirname(base);
		const resolved = nameText
			? path.normalize(path.join(base, nameText)).replace(/\\/gu, "/")
			: base.replace(/\\/gu, "/");
		return resolved;
	}
	return moduleNameNode.text.replace(/\./gu, "/");
}

function extractImportBindings(
	root: SyntaxNode,
	filePath: string,
): ImportBinding[] {
	const bindings: ImportBinding[] = [];

	function walk(node: SyntaxNode): void {
		if (node.type === "import_from_statement") {
			const modNode = node.children.find(
				(c) => c.type === "relative_import" || c.type === "dotted_name",
			);
			if (!modNode) {
				for (const child of node.children) walk(child);
				return;
			}
			const specifier = moduleSpecifier(modNode, filePath);
			for (const child of node.children) {
				// Imported names appear as dotted_name or identifier (for simple names)
				if (
					(child.type === "dotted_name" || child.type === "identifier") &&
					child !== modNode
				) {
					const nameText = child.text;
					bindings.push({
						localName: nameText,
						importedName: nameText,
						fromSpecifier: specifier,
						bindingKind: "named",
					});
				} else if (child.type === "aliased_import") {
					const name = child.childForFieldName("name")?.text;
					const alias = child.childForFieldName("alias")?.text;
					if (name && alias) {
						bindings.push({
							localName: alias,
							importedName: name,
							fromSpecifier: specifier,
							bindingKind: "named",
						});
					}
				}
			}
			return;
		}
		if (node.type === "import_statement") {
			for (const child of node.children) {
				if (child.type === "aliased_import") {
					const nameNode = child.childForFieldName("name");
					const alias = child.childForFieldName("alias")?.text;
					if (nameNode && alias) {
						bindings.push({
							localName: alias,
							importedName: alias,
							fromSpecifier: nameNode.text.replace(/\./gu, "/"),
							bindingKind: "namespace",
						});
					}
				}
			}
			return;
		}
		for (const child of node.children) walk(child);
	}

	walk(root);
	return bindings;
}

function extractImportSitesFromRoot(
	root: SyntaxNode,
	filePath: string,
): RawImportSite[] {
	const sites: RawImportSite[] = [];

	function walk(node: SyntaxNode): void {
		if (node.type === "import_from_statement") {
			const modNode = node.children.find(
				(c) => c.type === "relative_import" || c.type === "dotted_name",
			);
			if (modNode) {
				const rawSpecifier =
					modNode.type === "relative_import"
						? modNode.text.replace(/\s+/gu, "")
						: modNode.text;
				const baseCandidate = moduleSpecifier(modNode, filePath);
				sites.push({
					from: filePath,
					rawSpecifier,
					candidate: baseCandidate,
				});
				// Also emit candidate per imported name; covers "from pkg import sub"
				// where `sub` is a subpackage (resolved via sub/__init__.py).
				for (const child of node.children) {
					let importedName: string | null = null;
					if (
						(child.type === "dotted_name" || child.type === "identifier") &&
						child !== modNode
					) {
						importedName = child.text.replace(/\./gu, "/");
					} else if (child.type === "aliased_import") {
						const nameNode = child.childForFieldName("name");
						if (nameNode) importedName = nameNode.text.replace(/\./gu, "/");
					}
					if (importedName) {
						sites.push({
							from: filePath,
							rawSpecifier: `${rawSpecifier}.${importedName}`,
							candidate: `${baseCandidate}/${importedName}`,
						});
					}
				}
			}
			return;
		}
		if (node.type === "import_statement") {
			for (const child of node.children) {
				let nameNode: SyntaxNode | null = null;
				if (child.type === "dotted_name") {
					nameNode = child;
				} else if (child.type === "aliased_import") {
					nameNode = child.childForFieldName("name") ?? null;
				}
				if (nameNode) {
					sites.push({
						from: filePath,
						rawSpecifier: nameNode.text,
						candidate: nameNode.text.replace(/\./gu, "/"),
					});
				}
			}
			return;
		}
		for (const child of node.children) walk(child);
	}

	walk(root);
	return sites;
}

const EMPTY: RawCallData = {
	functions: [],
	symbols: [],
	rawCalls: [],
	rawRefs: [],
	reexports: [],
	importBindings: [],
};

export async function createPythonAdapter(): Promise<LanguageAdapter> {
	await initParser();
	return {
		extensions: [".py"],
		capabilities: {
			importExtraction: true,
			callGraph: true,
			symbolIndex: true,
		},
		symbolKinds: PY_SYMBOL_KINDS,
		referenceKinds: PY_REF_KINDS,
		async extractImports(
			worktreePath: string,
			filePath: string,
			content?: string,
		): Promise<RawImportSite[]> {
			const source =
				content ??
				(await fs.promises.readFile(path.join(worktreePath, filePath), "utf8"));
			if (!pyParser) return [];
			let tree;
			try {
				tree = pyParser.parse(source);
			} catch {
				return [];
			}
			if (!tree) return [];
			try {
				return extractImportSitesFromRoot(tree.rootNode, filePath);
			} catch {
				return [];
			}
		},
		async extractCallGraph(
			worktreePath: string,
			filePath: string,
			content?: string,
		): Promise<RawCallData> {
			const source =
				content ??
				(await fs.promises.readFile(path.join(worktreePath, filePath), "utf8"));
			if (!pyParser) return EMPTY;
			let tree;
			try {
				tree = pyParser.parse(source);
			} catch {
				return EMPTY;
			}
			if (!tree) return EMPTY;
			try {
				const symbols = extractSymbols(tree.rootNode, filePath);
				return {
					functions: functionsFromSymbols(symbols),
					symbols,
					rawCalls: extractRawCalls(tree.rootNode, filePath),
					rawRefs: extractRawRefs(tree.rootNode, filePath),
					reexports: [],
					importBindings: extractImportBindings(tree.rootNode, filePath),
				};
			} catch {
				return EMPTY;
			}
		},
	};
}
