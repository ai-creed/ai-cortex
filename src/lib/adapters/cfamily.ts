// src/lib/adapters/cfamily.ts
import fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import type {
	LanguageAdapter,
	RawCallData,
	RawCallSite,
	RawImportSite,
	RawRefSite,
} from "../lang-adapter.js";
import type { SymbolKind, SymbolNode } from "../models.js";
import {
	C_REF_KINDS,
	C_SYMBOL_KINDS,
} from "../symbols.js";
import { rangeFromNode } from "./_range.js";

const require = createRequire(import.meta.url);

let cParser: import("web-tree-sitter").Parser | null = null;
let cppParser: import("web-tree-sitter").Parser | null = null;
let initPromise: Promise<void> | null = null;

type SyntaxNode = import("web-tree-sitter").Node;

async function initParsers(): Promise<void> {
	if (initPromise) return initPromise;
	initPromise = (async () => {
		const { Parser: TreeSitter, Language } = await import("web-tree-sitter");
		await TreeSitter.init();

		const cGrammarPath = require.resolve("tree-sitter-c/tree-sitter-c.wasm");
		const cppGrammarPath =
			require.resolve("tree-sitter-cpp/tree-sitter-cpp.wasm");

		const cLang = await Language.load(cGrammarPath);
		const cppLang = await Language.load(cppGrammarPath);

		cParser = new TreeSitter();
		cParser.setLanguage(cLang);

		cppParser = new TreeSitter();
		cppParser.setLanguage(cppLang);
	})();
	return initPromise;
}

const CPP_EXTS = [
	".cpp",
	".cc",
	".cxx",
	".c++",
	".hpp",
	".hh",
	".hxx",
	".h++",
	".h",
];

function getStorageClass(node: SyntaxNode): string | null {
	for (const child of node.children) {
		if (child.type === "storage_class_specifier") return child.text;
	}
	return null;
}

function declaratorName(declarator: SyntaxNode): string | null {
	// If the node itself is a terminal name node, return its text directly
	if (
		declarator.type === "identifier" ||
		declarator.type === "field_identifier" ||
		declarator.type === "qualified_identifier" ||
		declarator.type === "destructor_name" ||
		declarator.type === "operator_name"
	) {
		return declarator.text;
	}
	const name = declarator.childForFieldName("declarator");
	if (!name) return null;
	return declaratorName(name);
}

function findFunctionDeclarator(node: SyntaxNode): SyntaxNode | null {
	if (node.type === "function_declarator") return node;
	for (const child of node.children) {
		// A nested type body (struct X { void m(); } x;) holds its own members.
		if (child.type === "field_declaration_list") continue;
		const r = findFunctionDeclarator(child);
		if (r) return r;
	}
	return null;
}

/** Returns true if the declarator chain (via "declarator" field) contains a pointer_declarator.
 *  Used to distinguish function prototypes from function-pointer variable declarations. */
function hasPointerInChain(node: SyntaxNode): boolean {
	if (node.type === "pointer_declarator") return true;
	const child = node.childForFieldName("declarator");
	if (child) return hasPointerInChain(child);
	return false;
}

function joinQualified(parts: string[], leaf: string): string {
	if (parts.length === 0) return leaf;
	return `${parts.join(".")}.${leaf}`;
}

/** Normalize C++ scope-resolution source text to the '.'-separated qualified-name form. */
const dotName = (n: string): string => n.replace(/::/g, ".");

/** Return the namespace_identifier text for a namespace_definition node, or null. */
function namespaceIdentifier(node: SyntaxNode): string | null {
	for (const child of node.children) {
		if (child.type === "namespace_identifier") return child.text;
	}
	return null;
}

const CLASS_LIKE = new Set(["class_specifier", "struct_specifier", "union_specifier"]);

function className(node: SyntaxNode): string | null {
	for (const child of node.children) {
		if (child.type === "type_identifier") return child.text;
	}
	return null;
}

/** Namespace and class segments (outermost first) enclosing `from`, inclusive.
 *  Mirrors the nesting extractSymbols builds so call/ref sites agree with symbols. */
function scopeSegments(from: SyntaxNode | null): string[] {
	const segs: string[] = [];
	for (let cur = from; cur; cur = cur.parent) {
		if (cur.type === "namespace_definition") {
			const nsName = namespaceIdentifier(cur);
			if (nsName) segs.unshift(...nsName.split("::").filter(Boolean));
		} else if (CLASS_LIKE.has(cur.type)) {
			const cls = className(cur);
			if (cls) segs.unshift(cls);
		}
	}
	return segs;
}

function extractSymbols(root: SyntaxNode, filePath: string): SymbolNode[] {
	const out: SymbolNode[] = [];

	function emit(
		kind: SymbolKind,
		fullName: string,
		nameNode: SyntaxNode,
		declNode: SyntaxNode,
		opts: { exported: boolean; declOnly: boolean },
	): void {
		const qualifiedName = dotName(fullName);
		const idx = qualifiedName.lastIndexOf(".");
		const name = idx === -1 ? qualifiedName : qualifiedName.slice(idx + 1);
		out.push({
			qualifiedName,
			name,
			file: filePath,
			kind,
			...(idx === -1 ? {} : { containerQualifiedName: qualifiedName.slice(0, idx) }),
			exported: opts.exported,
			isDefaultExport: false,
			isDeclarationOnly: opts.declOnly,
			range: rangeFromNode(declNode),
			nameRange: rangeFromNode(nameNode),
		});
	}

	/** The leaf identifier node of a declarator chain (for name ranges). */
	function leafNameNode(declarator: SyntaxNode): SyntaxNode {
		if (
			declarator.type === "identifier" ||
			declarator.type === "field_identifier" ||
			declarator.type === "type_identifier" ||
			declarator.type === "qualified_identifier" ||
			declarator.type === "destructor_name" ||
			declarator.type === "operator_name"
		) {
			if (declarator.type === "qualified_identifier") {
				const n = declarator.childForFieldName("name");
				if (n) return leafNameNode(n);
			}
			return declarator;
		}
		if (declarator.type === "parenthesized_declarator") {
			const first = declarator.namedChildren[0];
			return first ? leafNameNode(first) : declarator;
		}
		const inner = declarator.childForFieldName("declarator");
		return inner ? leafNameNode(inner) : declarator;
	}

	function walk(node: SyntaxNode, nsStack: string[], className: string | null): void {
		if (node.type === "preproc_def" || node.type === "preproc_function_def") {
			const n = node.childForFieldName("name");
			if (n) emit("macro", n.text, n, node, { exported: true, declOnly: false });
			return;
		}
		if (node.type === "namespace_definition") {
			const nsName = namespaceIdentifier(node);
			const segs: string[] = [];
			if (nsName) for (const part of nsName.split("::")) if (part) segs.push(part);
			for (const child of node.children) {
				if (child.type === "declaration_list") walk(child, [...nsStack, ...segs], className);
			}
			return;
		}
		if (node.type === "class_specifier" || node.type === "struct_specifier" || node.type === "union_specifier") {
			const nameNode = node.children.find((c) => c.type === "type_identifier");
			const cls = nameNode?.text ?? null;
			const body = node.children.find((c) => c.type === "field_declaration_list");
			if (cls && nameNode && body) {
				// Forward declarations (no body) are not emitted.
				const kind: SymbolKind = node.type === "class_specifier" ? "class" : "struct";
				emit(kind, joinQualified(nsStack, className ? `${className}.${cls}` : cls), nameNode, node, { exported: true, declOnly: false });
			}
			if (body) walk(body, nsStack, cls ? (className ? `${className}.${cls}` : cls) : className);
			return;
		}
		if (node.type === "enum_specifier") {
			const nameNode = node.children.find((c) => c.type === "type_identifier");
			const body = node.children.find((c) => c.type === "enumerator_list");
			if (nameNode && body) {
				const enumQn = joinQualified(nsStack, className ? `${className}.${nameNode.text}` : nameNode.text);
				emit("enum", enumQn, nameNode, node, { exported: true, declOnly: false });
				for (const e of body.namedChildren) {
					if (e.type !== "enumerator") continue;
					const en = e.childForFieldName("name");
					if (en) emit("enum_member", `${enumQn}.${en.text}`, en, e, { exported: true, declOnly: false });
				}
			}
			return;
		}
		if (node.type === "type_definition") {
			const decl = node.childForFieldName("declarator");
			if (decl) {
				const leaf = leafNameNode(decl);
				emit("type", joinQualified(nsStack, leaf.text), leaf, node, { exported: true, declOnly: false });
			}
			// typedef struct { ... } Name; also walks the inner struct for its fields,
			// scoping an anonymous body under the typedef name.
			const typedefName = decl ? leafNameNode(decl).text : null;
			for (const c of node.namedChildren) {
				if (c.type !== "struct_specifier" && c.type !== "enum_specifier" && c.type !== "union_specifier") continue;
				const anonymous = !c.children.some((k) => k.type === "type_identifier");
				const scope = anonymous && typedefName ? (className ? `${className}.${typedefName}` : typedefName) : className;
				walk(c, nsStack, scope);
			}
			return;
		}
		if (node.type === "function_definition") {
			const declarator = node.childForFieldName("declarator");
			const fnDecl = declarator ? findFunctionDeclarator(declarator) : null;
			const inner = fnDecl?.childForFieldName("declarator");
			let name = inner ? declaratorName(inner) : null;
			if (name && inner) {
				if (!name.includes("::") && className) name = `${className}.${name}`;
				const isStatic = getStorageClass(node) === "static";
				const isMethod = name.includes("::") || className !== null;
				emit(isMethod ? "method" : "function", joinQualified(nsStack, name), leafNameNode(inner), node, { exported: !isStatic, declOnly: false });
			}
			return; // bodies are not indexed scope (lambdas inside are not symbols)
		}
		if (node.type === "declaration" || node.type === "field_declaration") {
			const fnDecl = findFunctionDeclarator(node);
			if (fnDecl) {
				const inner = fnDecl.childForFieldName("declarator");
				if (inner && hasPointerInChain(inner)) {
					// function-pointer variable: treat as a variable/property below
				} else {
					let name = inner ? declaratorName(inner) : null;
					if (name && inner) {
						if (!name.includes("::") && className) name = `${className}.${name}`;
						const isStatic = getStorageClass(node) === "static";
						const isMethod = name.includes("::") || className !== null;
						emit(isMethod ? "method" : "function", joinQualified(nsStack, name), leafNameNode(inner), node, { exported: !isStatic, declOnly: true });
					}
					return;
				}
			}
			// Non-function declarator(s): file-scope variables or class fields.
			for (const c of node.children) {
				const d = c.type === "init_declarator" ? c.childForFieldName("declarator") : c;
				if (!d) continue;
				const leaf = leafNameNode(d);
				if (leaf.type !== "identifier" && leaf.type !== "field_identifier") continue;
				const kind: SymbolKind = node.type === "field_declaration" ? "property" : "variable";
				const base = className ? `${className}.${leaf.text}` : leaf.text;
				emit(kind, joinQualified(nsStack, base), leaf, node, { exported: getStorageClass(node) !== "static", declOnly: node.type === "field_declaration" });
			}
			// Nested struct/enum definitions inside a declaration (struct X {...} x;)
			for (const c of node.namedChildren) if (c.type === "struct_specifier" || c.type === "enum_specifier" || c.type === "class_specifier" || c.type === "union_specifier") walk(c, nsStack, className);
			return;
		}
		for (const child of node.children) walk(child, nsStack, className);
	}

	walk(root, [], null);
	return out;
}

/** Qualified name of a function_definition in the same '.' form extractSymbols
 *  emits. Out-of-line `Foo::bar` keeps only namespace prefixes. */
function definitionName(def: SyntaxNode): { qualifiedName: string; outOfLine: boolean } | null {
	const decl = def.childForFieldName("declarator");
	const fnDecl = decl ? findFunctionDeclarator(decl) : null;
	const inner = fnDecl?.childForFieldName("declarator");
	const name = inner ? declaratorName(inner) : null;
	if (!name) return null;
	if (!name.includes("::")) {
		return { qualifiedName: joinQualified(scopeSegments(def.parent), name), outOfLine: false };
	}
	const nsOnly: string[] = [];
	for (let o: SyntaxNode | null = def.parent; o; o = o.parent) {
		if (o.type !== "namespace_definition") continue;
		const nsName = namespaceIdentifier(o);
		if (nsName) nsOnly.unshift(...nsName.split("::").filter(Boolean));
	}
	return { qualifiedName: dotName(joinQualified(nsOnly, name)), outOfLine: true };
}

function findEnclosingFunctionName(node: SyntaxNode): string | null {
	for (let cur = node.parent; cur; cur = cur.parent) {
		if (cur.type !== "function_definition") continue;
		const def = definitionName(cur);
		if (def) return def.qualifiedName;
	}
	return null;
}

/** Fully qualified innermost enclosing class, or for an out-of-line
 *  `Foo::bar` definition the qualifier before the last '.'. */
function findEnclosingClassName(node: SyntaxNode): string | null {
	for (let cur = node.parent; cur; cur = cur.parent) {
		if (CLASS_LIKE.has(cur.type) && className(cur)) return scopeSegments(cur).join(".");
		if (cur.type !== "function_definition") continue;
		const def = definitionName(cur);
		if (def?.outOfLine) {
			const idx = def.qualifiedName.lastIndexOf(".");
			return idx === -1 ? null : def.qualifiedName.slice(0, idx);
		}
	}
	return null;
}

type CallTarget = {
	/** Token for the callee name, used for ref ranges. */
	token: SyntaxNode;
	name: string;
	receiver?: string;
	rawCallee: string;
	kind: RawCallSite["kind"];
};

/** Resolve a call_expression's function node into receiver/member parts. */
function callTarget(fnNode: SyntaxNode): CallTarget | null {
	if (fnNode.type === "field_expression") {
		const obj = fnNode.childForFieldName("argument");
		const field = fnNode.childForFieldName("field");
		if (!field) return null;
		const receiver = obj?.text ?? "";
		return { token: field, name: field.text, receiver, rawCallee: `${receiver}.${field.text}`, kind: "method" };
	}
	if (fnNode.type === "qualified_identifier") {
		let leaf: SyntaxNode = fnNode;
		while (leaf.type === "qualified_identifier") {
			const next = leaf.childForFieldName("name");
			if (!next) break;
			leaf = next;
		}
		const full = dotName(fnNode.text);
		const idx = full.lastIndexOf(".");
		const receiver = idx > 0 ? full.slice(0, idx) : undefined;
		return { token: leaf, name: leaf.text, ...(receiver ? { receiver } : {}), rawCallee: full, kind: "call" };
	}
	if (fnNode.type === "identifier") {
		return { token: fnNode, name: fnNode.text, rawCallee: fnNode.text, kind: "call" };
	}
	return null;
}

/** Split a `new` type node into the leaf name token and its scope receiver. */
function newTarget(typeNode: SyntaxNode): { token: SyntaxNode; name: string; receiver?: string } {
	const target = typeNode.type === "qualified_identifier" ? callTarget(typeNode) : null;
	if (target) return { token: target.token, name: target.name, ...(target.receiver ? { receiver: target.receiver } : {}) };
	return { token: typeNode, name: typeNode.text };
}

function newTypeNode(node: SyntaxNode): SyntaxNode | undefined {
	return (
		node.childForFieldName("type") ??
		node.childForFieldName("constructor") ??
		node.children.find((c: SyntaxNode) => c.type === "type_identifier") ??
		undefined
	);
}

function extractRawCalls(root: SyntaxNode, filePath: string): RawCallSite[] {
	const calls: RawCallSite[] = [];

	function walk(node: SyntaxNode): void {
		if (node.type === "call_expression") {
			const fnNode = node.childForFieldName("function");
			if (fnNode) {
				const target = callTarget(fnNode);
				const caller = findEnclosingFunctionName(node);
				if (caller) {
					const enclosingClass = findEnclosingClassName(node);
					calls.push({
						callerQualifiedName: caller,
						callerFile: filePath,
						rawCallee: target ? target.rawCallee : fnNode.text,
						kind: target ? target.kind : "call",
						site: rangeFromNode(node),
						...(enclosingClass ? { enclosingClass } : {}),
					});
				}
			}
		}
		if (node.type === "new_expression") {
			const typeNode = newTypeNode(node);
			if (typeNode) {
				const caller = findEnclosingFunctionName(node);
				if (caller) {
					const enclosingClass = findEnclosingClassName(node);
					calls.push({
						callerQualifiedName: caller,
						callerFile: filePath,
						rawCallee: dotName(typeNode.text),
						kind: "new",
						site: rangeFromNode(node),
						...(enclosingClass ? { enclosingClass } : {}),
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

	function push(kind: "call" | "new", name: string, token: SyntaxNode, site: SyntaxNode, receiver?: string): void {
		const enclosingQualifiedName = findEnclosingFunctionName(site);
		const enclosingClass = findEnclosingClassName(site);
		refs.push({
			file: filePath,
			name,
			kind,
			range: rangeFromNode(token),
			...(receiver ? { receiver } : {}),
			...(enclosingQualifiedName ? { enclosingQualifiedName } : {}),
			...(enclosingClass ? { enclosingClass } : {}),
		});
	}

	function walk(node: SyntaxNode): void {
		if (node.type === "call_expression") {
			const fnNode = node.childForFieldName("function");
			const target = fnNode ? callTarget(fnNode) : null;
			if (target) push("call", target.name, target.token, node, target.receiver);
		}
		if (node.type === "new_expression") {
			const typeNode = newTypeNode(node);
			if (typeNode) {
				const t = newTarget(typeNode);
				push("new", t.name, t.token, node, t.receiver);
			}
		}
		for (const child of node.children) walk(child);
	}

	walk(root);
	refs.sort((a, b) => a.range.line - b.range.line || a.range.column - b.range.column);
	return refs;
}

function extractImportSitesFromRoot(
	root: SyntaxNode,
	filePath: string,
): RawImportSite[] {
	const sites: RawImportSite[] = [];

	function walk(node: SyntaxNode): void {
		if (node.type === "preproc_include") {
			const pathNode = node.childForFieldName("path");
			if (pathNode && pathNode.type === "string_literal") {
				const raw = pathNode.text;
				const m = raw.match(/^"([^"]+)"$/);
				if (m) {
					const rawSpecifier = m[1];
					const candidate = path
						.normalize(path.join(path.dirname(filePath), rawSpecifier))
						.replace(/\\/g, "/");
					sites.push({ from: filePath, rawSpecifier, candidate });
				}
			}
			// system_lib_string nodes are ignored
		}
		for (const child of node.children) walk(child);
	}

	walk(root);
	return sites;
}

function emptyCallData(): RawCallData {
	return {
		symbols: [],
		rawCalls: [],
		rawRefs: [],
		reexports: [],
		importBindings: [],
	};
}

function buildAdapter(
	exts: string[],
	parserGetter: () => import("web-tree-sitter").Parser | null,
): LanguageAdapter {
	return {
		extensions: exts,
		capabilities: {
			importExtraction: true,
			callGraph: true,
			symbolIndex: true,
		},
		symbolKinds: C_SYMBOL_KINDS,
		referenceKinds: C_REF_KINDS,
		async extractImports(
			worktreePath: string,
			filePath: string,
			content?: string,
		): Promise<RawImportSite[]> {
			const source =
				content ??
				(await fs.promises.readFile(path.join(worktreePath, filePath), "utf8"));
			const parser = parserGetter();
			if (!parser) return [];
			const tree = parser.parse(source);
			if (!tree) return [];
			return extractImportSitesFromRoot(tree.rootNode, filePath);
		},
		async extractCallGraph(
			worktreePath: string,
			filePath: string,
			content?: string,
		): Promise<RawCallData> {
			const source =
				content ??
				(await fs.promises.readFile(path.join(worktreePath, filePath), "utf8"));
			const parser = parserGetter();
			if (!parser) return emptyCallData();
			const tree = parser.parse(source);
			if (!tree) return emptyCallData();
			const root = tree.rootNode;
			const symbols = extractSymbols(root, filePath);
			return {
				symbols,
				rawCalls: extractRawCalls(root, filePath),
				rawRefs: extractRawRefs(root, filePath),
				reexports: [],
				importBindings: [],
			};
		},
	};
}

export async function createCAdapter(): Promise<LanguageAdapter> {
	await initParsers();
	return buildAdapter([".c"], () => cParser);
}

export async function createCppAdapter(): Promise<LanguageAdapter> {
	await initParsers();
	return buildAdapter(CPP_EXTS, () => cppParser);
}
