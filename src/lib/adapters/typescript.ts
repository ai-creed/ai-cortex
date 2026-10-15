// src/lib/adapters/typescript.ts
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Range, SymbolKind, SymbolNode } from "../models.js";
import type {
	LanguageAdapter,
	RawCallData,
	RawCallSite,
	ImportBinding,
	RawImportSite,
} from "../lang-adapter.js";
import { functionsFromSymbols, TS_REF_KINDS, TS_SYMBOL_KINDS } from "../symbols.js";
import { rangeFromNode } from "./_range.js";

const require = createRequire(import.meta.url);

// Lazy-initialized parser state
let tsParser: import("web-tree-sitter").Parser | null = null;
let tsxParser: import("web-tree-sitter").Parser | null = null;
let jsParser: import("web-tree-sitter").Parser | null = null;

// Promise cache to prevent concurrent initialization
let initPromise: Promise<void> | null = null;

type SyntaxNode = import("web-tree-sitter").Node;

async function initParsers(): Promise<void> {
	if (initPromise) return initPromise;
	initPromise = (async () => {
		const { Parser: TreeSitter, Language } = await import("web-tree-sitter");
		await TreeSitter.init();

		// tree-sitter-typescript ships TS and TSX grammars
		const tsGrammarPath =
			require.resolve("tree-sitter-typescript/tree-sitter-typescript.wasm");
		const tsxGrammarPath =
			require.resolve("tree-sitter-typescript/tree-sitter-tsx.wasm");
		// tree-sitter-javascript ships JS grammar (handles JSX too)
		const jsGrammarPath =
			require.resolve("tree-sitter-javascript/tree-sitter-javascript.wasm");

		const tsLang = await Language.load(tsGrammarPath);
		const tsxLang = await Language.load(tsxGrammarPath);
		const jsLang = await Language.load(jsGrammarPath);

		tsParser = new TreeSitter();
		tsParser.setLanguage(tsLang);

		tsxParser = new TreeSitter();
		tsxParser.setLanguage(tsxLang);

		jsParser = new TreeSitter();
		jsParser.setLanguage(jsLang);
	})();
	return initPromise;
}

function parserForExt(ext: string): import("web-tree-sitter").Parser | null {
	if (ext === ".tsx") return tsxParser;
	if (ext === ".ts") return tsParser;
	if (ext === ".jsx" || ext === ".js") return jsParser;
	return null;
}
type Scope = {
	qualifiedName: string; // container path so far, "" at module scope
	enclosingClass?: string; // innermost class qualified name
	exported: boolean; // true when the container is exported (class members inherit)
	declareContext?: boolean; // inside an ambient `declare` declaration
};

const MODULE_SCOPE: Scope = { qualifiedName: "", exported: false };

function qn(scope: Scope, name: string): string {
	return scope.qualifiedName ? `${scope.qualifiedName}.${name}` : name;
}

/** Name text for a property/method/field name node: identifiers as-is,
 *  string literals and computed string keys unquoted. */
function memberName(nameNode: SyntaxNode): string | null {
	if (nameNode.type === "computed_property_name") {
		const inner = nameNode.namedChildren[0];
		if (!inner) return null;
		return memberName(inner);
	}
	if (nameNode.type === "string") {
		const frag = nameNode.namedChildren.find((c) => c.type === "string_fragment");
		return frag ? frag.text : nameNode.text.slice(1, -1);
	}
	if (nameNode.type === "number") return nameNode.text;
	return nameNode.text;
}

/** Narrow the range of a name node to the literal text when it is quoted or
 *  computed, so the jump lands on the identifier, not the brackets. */
function nameRangeOf(nameNode: SyntaxNode): Range {
	if (nameNode.type === "computed_property_name") {
		const inner = nameNode.namedChildren[0];
		if (inner) return nameRangeOf(inner);
	}
	if (nameNode.type === "string") {
		const frag = nameNode.namedChildren.find((c) => c.type === "string_fragment");
		if (frag) return rangeFromNode(frag);
	}
	return rangeFromNode(nameNode);
}

/** export flags for a declaration node, looking through export_statement. */
function exportFlags(node: SyntaxNode, scope: Scope): { exported: boolean; isDefault: boolean } {
	const parent = node.parent;
	if (parent?.type === "export_statement") {
		const isDefault = parent.children.some((c) => c.type === "default");
		return { exported: true, isDefault };
	}
	// Members of an exported container count as exported (today's behavior).
	return { exported: scope.exported, isDefault: false };
}

function isFunctionValue(node: SyntaxNode | null): boolean {
	return (
		!!node &&
		(node.type === "arrow_function" || node.type === "function_expression")
	);
}

function extractSymbols(root: SyntaxNode, filePath: string): SymbolNode[] {
	const out: SymbolNode[] = [];

	function emit(
		kind: SymbolKind,
		nameNode: SyntaxNode,
		declNode: SyntaxNode,
		scope: Scope,
		opts: { exported: boolean; isDefault: boolean; declOnly: boolean; nameText?: string },
	): string | null {
		const name = opts.nameText ?? memberName(nameNode);
		if (!name) return null;
		const qualifiedName = qn(scope, name);
		out.push({
			qualifiedName,
			name,
			file: filePath,
			kind,
			...(scope.qualifiedName ? { containerQualifiedName: scope.qualifiedName } : {}),
			exported: opts.exported,
			isDefaultExport: opts.isDefault,
			isDeclarationOnly: opts.declOnly,
			range: rangeFromNode(declNode),
			nameRange: nameRangeOf(nameNode),
		});
		return qualifiedName;
	}

	function emitPatternNames(pattern: SyntaxNode, declNode: SyntaxNode, scope: Scope, exported: boolean): void {
		if (pattern.type === "identifier") {
			emit("variable", pattern, declNode, scope, { exported, isDefault: false, declOnly: false });
			return;
		}
		if (pattern.type === "shorthand_property_identifier_pattern") {
			emit("variable", pattern, declNode, scope, { exported, isDefault: false, declOnly: false });
			return;
		}
		if (pattern.type === "pair_pattern") {
			const value = pattern.childForFieldName("value");
			if (value) emitPatternNames(value, declNode, scope, exported);
			return;
		}
		if (pattern.type === "assignment_pattern") {
			const left = pattern.childForFieldName("left");
			if (left) emitPatternNames(left, declNode, scope, exported);
			return;
		}
		if (pattern.type === "rest_pattern") {
			for (const c of pattern.namedChildren) emitPatternNames(c, declNode, scope, exported);
			return;
		}
		if (pattern.type === "object_pattern" || pattern.type === "array_pattern") {
			for (const c of pattern.namedChildren) emitPatternNames(c, declNode, scope, exported);
		}
	}

	function walkContainerBody(body: SyntaxNode | null, scope: Scope): void {
		if (!body) return;
		for (const child of body.children) walk(child, scope);
	}

	function walk(node: SyntaxNode, scope: Scope): void {
		switch (node.type) {
			case "export_statement": {
				// export default <anonymous fn/class>: keep today's "default" convention.
				const defaultTok = node.children.find((c) => c.type === "default");
				const decl = node.childForFieldName("declaration");
				const value = node.childForFieldName("value");
				if (defaultTok && !decl && value && (isFunctionValue(value) || value.type === "class")) {
					emit(value.type === "class" ? "class" : "function", defaultTok, value, scope, {
						exported: true,
						isDefault: true,
						declOnly: false,
						nameText: "default",
					});
					if (value.type === "class") {
						walkContainerBody(value.childForFieldName("body"), {
							qualifiedName: qn(scope, "default"),
							enclosingClass: qn(scope, "default"),
							exported: true,
						});
					}
					return;
				}
				// Anonymous `export default class {}` arrives as declaration without a name.
				if (defaultTok && decl && (decl.type === "class_declaration" || decl.type === "class") && !decl.childForFieldName("name")) {
					emit("class", defaultTok, decl, scope, { exported: true, isDefault: true, declOnly: false, nameText: "default" });
					walkContainerBody(decl.childForFieldName("body"), {
						qualifiedName: qn(scope, "default"),
						enclosingClass: qn(scope, "default"),
						exported: true,
					});
					return;
				}
				if (defaultTok && decl && decl.type === "function_declaration" && !decl.childForFieldName("name")) {
					emit("function", defaultTok, decl, scope, { exported: true, isDefault: true, declOnly: false, nameText: "default" });
					return;
				}
				for (const child of node.children) walk(child, scope);
				return;
			}
			case "ambient_declaration": {
				// declare function/class/const ...: the inner declaration is declaration-only.
				for (const child of node.namedChildren) walk(child, { ...scope, declareContext: true });
				return;
			}
			case "function_declaration":
			case "function_signature": {
				const nameNode = node.childForFieldName("name");
				if (!nameNode) return;
				const { exported, isDefault } = exportFlags(node, scope);
				const declOnly =
					node.type === "function_signature" ||
					!!scope.declareContext;
				emit("function", nameNode, node, scope, { exported, isDefault, declOnly });
				return; // function bodies are not indexed scope
			}
			case "lexical_declaration":
			case "variable_declaration": {
				const { exported } = exportFlags(node, scope);
				for (const declarator of node.children) {
					if (declarator.type !== "variable_declarator") continue;
					const nameNode = declarator.childForFieldName("name");
					const valueNode = declarator.childForFieldName("value");
					if (!nameNode) continue;
					if (nameNode.type === "identifier" && isFunctionValue(valueNode)) {
						emit("function", nameNode, node, scope, { exported, isDefault: false, declOnly: false });
						continue;
					}
					if (nameNode.type === "identifier" && valueNode?.type === "class") {
						const clsQn = emit("class", nameNode, node, scope, { exported, isDefault: false, declOnly: false });
						if (clsQn) walkContainerBody(valueNode.childForFieldName("body"), { qualifiedName: clsQn, enclosingClass: clsQn, exported });
						continue;
					}
					emitPatternNames(nameNode, node, scope, exported);
				}
				return;
			}
			case "class_declaration":
			case "abstract_class_declaration": {
				const nameNode = node.childForFieldName("name");
				if (!nameNode) return;
				const { exported, isDefault } = exportFlags(node, scope);
				const declOnly = !!scope.declareContext;
				const clsQn = emit("class", nameNode, node, scope, { exported, isDefault, declOnly });
				if (clsQn) walkContainerBody(node.childForFieldName("body"), { qualifiedName: clsQn, enclosingClass: clsQn, exported });
				return;
			}
			case "method_definition":
			case "method_signature":
			case "abstract_method_signature": {
				const nameNode = node.childForFieldName("name");
				if (!nameNode) return;
				const declOnly = node.type !== "method_definition" || !node.childForFieldName("body");
				emit("method", nameNode, node, scope, { exported: scope.exported, isDefault: false, declOnly });
				return;
			}
			case "public_field_definition":
			case "property_signature": {
				const nameNode = node.childForFieldName("name");
				if (!nameNode) return;
				emit("property", nameNode, node, scope, {
					exported: scope.exported,
					isDefault: false,
					declOnly: node.type === "property_signature",
				});
				return;
			}
			case "interface_declaration": {
				const nameNode = node.childForFieldName("name");
				if (!nameNode) return;
				const { exported } = exportFlags(node, scope);
				const ifQn = emit("interface", nameNode, node, scope, { exported, isDefault: false, declOnly: true });
				if (ifQn) walkContainerBody(node.childForFieldName("body"), { qualifiedName: ifQn, exported });
				return;
			}
			case "type_alias_declaration": {
				const nameNode = node.childForFieldName("name");
				if (!nameNode) return;
				const { exported } = exportFlags(node, scope);
				emit("type", nameNode, node, scope, { exported, isDefault: false, declOnly: true });
				return;
			}
			case "enum_declaration": {
				const nameNode = node.childForFieldName("name");
				if (!nameNode) return;
				const { exported } = exportFlags(node, scope);
				const enumQn = emit("enum", nameNode, node, scope, { exported, isDefault: false, declOnly: false });
				const body = node.childForFieldName("body");
				if (enumQn && body) {
					const enumScope: Scope = { qualifiedName: enumQn, exported };
					for (const m of body.namedChildren) {
						if (m.type === "enum_assignment") {
							const n = m.childForFieldName("name");
							if (n) emit("enum_member", n, m, enumScope, { exported, isDefault: false, declOnly: false });
						} else if (m.type === "property_identifier" || m.type === "string" || m.type === "computed_property_name") {
							emit("enum_member", m, m, enumScope, { exported, isDefault: false, declOnly: false });
						}
					}
				}
				return;
			}
			case "internal_module":
			case "module": {
				const nameNode = node.childForFieldName("name");
				if (!nameNode) return;
				const { exported } = exportFlags(node, scope);
				// `namespace A.B {}` nests: emit A then B.
				const parts = nameNode.type === "nested_identifier" ? nameNode.text.split(".") : [memberName(nameNode) ?? nameNode.text];
				let inner: Scope = scope;
				for (let i = 0; i < parts.length; i++) {
					const isLast = i === parts.length - 1;
					const nsNameNode = isLast && nameNode.type !== "nested_identifier" ? nameNode : nameNode;
					const nsQn = emit("namespace", nsNameNode, node, inner, { exported, isDefault: false, declOnly: false, nameText: parts[i] });
					if (!nsQn) return;
					inner = { qualifiedName: nsQn, enclosingClass: inner.enclosingClass, exported };
				}
				walkContainerBody(node.childForFieldName("body"), inner);
				return;
			}
			case "arrow_function":
			case "function_expression":
			case "statement_block":
				// Function-local scope: never indexed. (statement_block reached here only
				// when not a namespace body, i.e. a bare block.)
				if (node.type !== "statement_block") return;
				break;
		}
		for (const child of node.children) walk(child, scope);
	}

	for (const child of root.children) walk(child, MODULE_SCOPE);
	return out;
}

/** Enclosing indexed declaration for a node inside a body: the chain of
 *  containers from the outermost down to the first function-like declaration
 *  (functions cannot contain indexed declarations), joined with '.'. */
export function enclosingContext(node: SyntaxNode): {
	qualifiedName?: string;
	enclosingClass?: string;
} {
	type Entry = { name: string; isClass: boolean; isFunction: boolean };
	const chain: Entry[] = [];
	let cur: SyntaxNode | null = node.parent;
	while (cur) {
		if (cur.type === "method_definition") {
			const n = cur.childForFieldName("name");
			if (n) chain.unshift({ name: memberName(n) ?? n.text, isClass: false, isFunction: true });
		} else if (cur.type === "class_declaration" || cur.type === "abstract_class_declaration" || cur.type === "class") {
			const n = cur.childForFieldName("name");
			if (n) chain.unshift({ name: n.text, isClass: true, isFunction: false });
			else if (cur.parent?.type === "export_statement" || cur.parent?.type === "variable_declarator") {
				const vn = cur.parent.type === "variable_declarator" ? cur.parent.childForFieldName("name")?.text : "default";
				if (vn) chain.unshift({ name: vn, isClass: true, isFunction: false });
			}
		} else if (cur.type === "internal_module" || cur.type === "module") {
			const n = cur.childForFieldName("name");
			if (n) for (const part of n.text.split(".").reverse()) chain.unshift({ name: part, isClass: false, isFunction: false });
		} else if (cur.type === "function_declaration") {
			const n = cur.childForFieldName("name");
			if (n) chain.unshift({ name: n.text, isClass: false, isFunction: true });
			else if (cur.parent?.type === "export_statement") chain.unshift({ name: "default", isClass: false, isFunction: true });
		} else if (cur.type === "arrow_function" || cur.type === "function_expression") {
			if (cur.parent?.type === "variable_declarator") {
				const n = cur.parent.childForFieldName("name");
				if (n && n.type === "identifier") chain.unshift({ name: n.text, isClass: false, isFunction: true });
			} else if (cur.parent?.type === "export_statement") {
				chain.unshift({ name: "default", isClass: false, isFunction: true });
			}
		}
		cur = cur.parent;
	}
	// Truncate at the first function-like entry from the outside in.
	const kept: Entry[] = [];
	for (const e of chain) {
		kept.push(e);
		if (e.isFunction) break;
	}
	if (kept.length === 0) return {};
	const qualifiedName = kept.map((e) => e.name).join(".");
	let enclosingClass: string | undefined;
	const lastClass = kept.map((e, i) => (e.isClass ? i : -1)).filter((i) => i >= 0).pop();
	if (lastClass !== undefined) enclosingClass = kept.slice(0, lastClass + 1).map((e) => e.name).join(".");
	return { qualifiedName, enclosingClass };
}

function extractRawCalls(root: SyntaxNode, filePath: string): RawCallSite[] {
	const calls: RawCallSite[] = [];

	function walk(node: SyntaxNode): void {
		if (node.type === "call_expression") {
			const funcNode = node.childForFieldName("function");
			if (!funcNode) {
				walkChildren(node);
				return;
			}

			let rawCallee: string;
			let kind: RawCallSite["kind"];

			if (funcNode.type === "member_expression") {
				const obj = funcNode.childForFieldName("object")?.text ?? "";
				const prop = funcNode.childForFieldName("property")?.text ?? "";
				rawCallee = `${obj}.${prop}`;
				kind = "method";
			} else {
				rawCallee = funcNode.text;
				kind = "call";
			}

			const ctx = enclosingContext(node);
			const caller = ctx.qualifiedName ?? null;
			if (caller) {
				calls.push({
					callerQualifiedName: caller,
					callerFile: filePath,
					rawCallee,
					kind,
					site: rangeFromNode(node),
					...(ctx.enclosingClass ? { enclosingClass: ctx.enclosingClass } : {}),
				});
			}
		} else if (node.type === "new_expression") {
			const ctorNode = node.childForFieldName("constructor");
			if (ctorNode) {
				const ctx = enclosingContext(node);
				const caller = ctx.qualifiedName ?? null;
				if (caller) {
					calls.push({
						callerQualifiedName: caller,
						callerFile: filePath,
						rawCallee: ctorNode.text,
						kind: "new",
						site: rangeFromNode(node),
						...(ctx.enclosingClass ? { enclosingClass: ctx.enclosingClass } : {}),
					});
				}
			}
		}
		walkChildren(node);
	}

	function walkChildren(node: SyntaxNode): void {
		for (const child of node.children) {
			walk(child);
		}
	}

	walk(root);
	return calls;
}

function extractImportBindings(root: SyntaxNode): ImportBinding[] {
	const bindings: ImportBinding[] = [];

	for (const node of root.children) {
		if (node.type !== "import_statement") continue;

		const sourceNode = node.childForFieldName("source");
		if (!sourceNode) continue;
		const specifier = sourceNode.text.replace(/['"]/g, "");
		// Only track relative imports
		if (!specifier.startsWith(".")) continue;

		for (const child of node.children) {
			// Default import: import Foo from "./bar"
			if (child.type === "identifier") {
				bindings.push({
					localName: child.text,
					importedName: "default",
					fromSpecifier: specifier,
					bindingKind: "default",
				});
			}
			// Named imports: import { foo, bar as baz } from "./mod"
			if (child.type === "import_clause") {
				for (const clauseChild of child.children) {
					if (clauseChild.type === "identifier") {
						// Default import in clause
						bindings.push({
							localName: clauseChild.text,
							importedName: "default",
							fromSpecifier: specifier,
							bindingKind: "default",
						});
					}
					if (clauseChild.type === "named_imports") {
						for (const spec of clauseChild.children) {
							if (spec.type !== "import_specifier") continue;
							const nameNode = spec.childForFieldName("name");
							const aliasNode = spec.childForFieldName("alias");
							if (!nameNode) continue;
							bindings.push({
								localName: aliasNode?.text ?? nameNode.text,
								importedName: nameNode.text,
								fromSpecifier: specifier,
								bindingKind: "named",
							});
						}
					}
					if (clauseChild.type === "namespace_import") {
						const nameNode = clauseChild.children.find(
							(c: SyntaxNode) => c.type === "identifier",
						);
						if (nameNode) {
							bindings.push({
								localName: nameNode.text,
								importedName: "*",
								fromSpecifier: specifier,
								bindingKind: "namespace",
							});
						}
					}
				}
			}
		}
	}

	return bindings;
}

const TS_STATIC_FROM_RE = /from\s+['"]([^'"]+)['"]/g;

function extractImportSitesFromSource(
	source: string,
	filePath: string,
): RawImportSite[] {
	const sites: RawImportSite[] = [];
	for (const match of source.matchAll(TS_STATIC_FROM_RE)) {
		const specifier = match[1];
		if (!specifier.startsWith(".")) continue;
		const candidate = path
			.normalize(path.join(path.dirname(filePath), specifier))
			.replace(/\\/g, "/")
			.replace(/\.(ts|tsx|js|jsx)$/u, "");
		sites.push({ from: filePath, rawSpecifier: specifier, candidate });
	}
	return sites;
}

export async function createTypescriptAdapter(): Promise<LanguageAdapter> {
	await initParsers();

	return {
		extensions: [".ts", ".tsx", ".js", ".jsx"],
		capabilities: {
			importExtraction: true,
			callGraph: true,
			symbolIndex: true,
		},
		symbolKinds: TS_SYMBOL_KINDS,
		referenceKinds: TS_REF_KINDS,
		async extractImports(
			worktreePath: string,
			filePath: string,
			content?: string,
		): Promise<RawImportSite[]> {
			const source =
				content ??
				(await fs.promises.readFile(path.join(worktreePath, filePath), "utf8"));
			return extractImportSitesFromSource(source, filePath);
		},
		async extractCallGraph(
			worktreePath: string,
			filePath: string,
			content?: string,
		): Promise<RawCallData> {
			const source =
				content ??
				(await fs.promises.readFile(path.join(worktreePath, filePath), "utf8"));
			const ext = path.extname(filePath);
			const parser = parserForExt(ext);
			if (!parser) return { functions: [], symbols: [], rawCalls: [], importBindings: [] };
			const tree = parser.parse(source);
			if (!tree) return { functions: [], symbols: [], rawCalls: [], importBindings: [] };
			const root = tree.rootNode;
			const symbols = extractSymbols(root, filePath);
			return {
				functions: functionsFromSymbols(symbols),
				symbols,
				rawCalls: extractRawCalls(root, filePath),
				importBindings: extractImportBindings(root),
			};
		},
	};
}
