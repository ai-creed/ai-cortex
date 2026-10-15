// src/lib/adapters/typescript.ts
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Range, ReexportRow, SymbolKind, SymbolNode } from "../models.js";
import type {
	LanguageAdapter,
	RawCallData,
	RawCallSite,
	ImportBinding,
	RawImportSite,
	RawRefSite,
} from "../lang-adapter.js";
import { TS_REF_KINDS, TS_SYMBOL_KINDS } from "../symbols.js";
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

/** Leaf identifiers of `A.B.C` in left-to-right order. */
function nestedIdentifierLeaves(node: SyntaxNode): SyntaxNode[] {
	if (node.type !== "nested_identifier") return [node];
	return node.namedChildren.flatMap(nestedIdentifierLeaves);
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
				const leaves = nameNode.type === "nested_identifier" ? nestedIdentifierLeaves(nameNode) : [nameNode];
				const parts = leaves.map((l) => memberName(l) ?? l.text);
				let inner: Scope = scope;
				for (let i = 0; i < parts.length; i++) {
					const nsQn = emit("namespace", leaves[i], node, inner, { exported, isDefault: false, declOnly: false, nameText: parts[i] });
					if (!nsQn) return;
					inner = { qualifiedName: nsQn, enclosingClass: inner.enclosingClass, exported };
				}
				walkContainerBody(node.childForFieldName("body"), inner);
				return;
			}
			case "object":
			case "class":
				// Object literals and class expressions that are not bound to a name
				// have no indexed members.
				return;
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

/** A method belongs to an indexed class only when it sits in a class body and
 *  the class is named or bound to a name (variable or default export). */
function isIndexedClassMember(method: SyntaxNode): boolean {
	const cls = method.parent?.parent;
	if (method.parent?.type !== "class_body" || !cls) return false;
	if (cls.childForFieldName("name")) return true;
	return cls.parent?.type === "export_statement" || cls.parent?.type === "variable_declarator";
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
		if (cur.type === "method_definition" && isIndexedClassMember(cur)) {
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

function stripQuotes(s: string): string {
	return s.replace(/^['"]|['"]$/g, "");
}

function extractRawRefs(
	root: SyntaxNode,
	filePath: string,
): { rawRefs: RawRefSite[]; reexports: ReexportRow[] } {
	const refs: RawRefSite[] = [];
	const reexports: ReexportRow[] = [];

	function push(
		kind: RawRefSite["kind"],
		token: SyntaxNode,
		at: SyntaxNode,
		extra: Partial<RawRefSite> = {},
	): void {
		const ctx = enclosingContext(at);
		const name = extra.name ?? memberName(token) ?? token.text;
		const site: RawRefSite = {
			file: filePath,
			name,
			kind,
			range: nameRangeOf(token),
			...(ctx.qualifiedName ? { enclosingQualifiedName: ctx.qualifiedName } : {}),
			...(ctx.enclosingClass ? { enclosingClass: ctx.enclosingClass } : {}),
		};
		if (extra.receiver !== undefined) site.receiver = extra.receiver;
		if (extra.specifier !== undefined) site.specifier = extra.specifier;
		if (extra.alias !== undefined) site.alias = extra.alias;
		if (extra.importKind !== undefined) site.importKind = extra.importKind;
		refs.push(site);
	}

	/** Rightmost identifier token and the receiver text to its left. */
	function splitMember(expr: SyntaxNode): { token: SyntaxNode; receiver: string } | null {
		if (expr.type !== "member_expression") return null;
		const obj = expr.childForFieldName("object");
		const prop = expr.childForFieldName("property");
		if (!obj || !prop) return null;
		return { token: prop, receiver: obj.text };
	}

	function typeIdentifiers(node: SyntaxNode): void {
		if (node.type === "type_identifier") {
			push("type", node, node);
			return;
		}
		if (node.type === "nested_type_identifier") {
			const nameNode = node.childForFieldName("name");
			const mod = node.childForFieldName("module");
			if (nameNode) push("type", nameNode, node, mod ? { receiver: mod.text } : {});
			return;
		}
		if (node.type === "type_query") {
			// typeof X: the identifier names a value symbol; record as type position.
			const id = node.namedChildren[0];
			if (id && id.type === "identifier") push("type", id, node);
			else if (id && id.type === "member_expression") {
				const m = splitMember(id);
				if (m) push("type", m.token, node, { receiver: m.receiver });
			}
			return;
		}
		if (node.type === "type_parameter") {
			// The parameter's own name is a declaration; only constraint and default are references.
			const nameNode = node.childForFieldName("name");
			for (const c of node.namedChildren) if (c.id !== nameNode?.id) typeIdentifiers(c);
			return;
		}
		if (node.type === "mapped_type_clause") {
			const nameNode = node.childForFieldName("name");
			for (const c of node.namedChildren) if (c.id !== nameNode?.id) typeIdentifiers(c);
			return;
		}
		if (node.type === "infer_type") {
			// `infer E` declares E; any constraint beyond the name is a reference.
			const nameNode = node.namedChildren[0];
			for (const c of node.namedChildren) if (c.id !== nameNode?.id) typeIdentifiers(c);
			return;
		}
		for (const c of node.namedChildren) typeIdentifiers(c);
	}

	function walk(node: SyntaxNode): void {
		switch (node.type) {
			case "import_statement": {
				const sourceNode = node.childForFieldName("source");
				if (!sourceNode) return; // side-effect import has source too; handled below
				const specifier = stripQuotes(sourceNode.text);
				const clause = node.children.find((c) => c.type === "import_clause");
				if (!clause) return; // import "./side": no row
				for (const c of clause.children) {
					if (c.type === "identifier") {
						push("import", c, node, { specifier, importKind: "default" });
					} else if (c.type === "namespace_import") {
						const id = c.children.find((x) => x.type === "identifier");
						if (id) push("import", id, node, { specifier, importKind: "namespace" });
					} else if (c.type === "named_imports") {
						for (const spec of c.namedChildren) {
							if (spec.type !== "import_specifier") continue;
							const nameNode = spec.childForFieldName("name");
							const aliasNode = spec.childForFieldName("alias");
							if (!nameNode) continue;
							push("import", nameNode, node, {
								specifier,
								importKind: "named",
								...(aliasNode ? { alias: aliasNode.text } : {}),
							});
						}
					}
				}
				return;
			}
			case "export_statement": {
				const sourceNode = node.childForFieldName("source");
				const specifier = sourceNode ? stripQuotes(sourceNode.text) : undefined;
				const clause = node.children.find((c) => c.type === "export_clause");
				if (clause) {
					for (const spec of clause.namedChildren) {
						if (spec.type !== "export_specifier") continue;
						const nameNode = spec.childForFieldName("name");
						const aliasNode = spec.childForFieldName("alias");
						if (!nameNode) continue;
						push("export", nameNode, node, {
							...(specifier !== undefined ? { specifier } : {}),
							...(aliasNode ? { alias: aliasNode.text } : {}),
						});
						if (specifier !== undefined) {
							reexports.push({
								file: filePath,
								exportedName: aliasNode?.text ?? nameNode.text,
								sourceName: nameNode.text,
								specifier,
							});
						}
					}
					return;
				}
				// `export * from`, `export * as ns from`: no row. Declarations: walk them.
				if (node.children.some((c) => c.type === "*")) return;
				for (const c of node.children) walk(c);
				return;
			}
			case "call_expression": {
				const fn = node.childForFieldName("function");
				if (fn) {
					const m = splitMember(fn);
					if (m) push("call", m.token, node, { receiver: m.receiver });
					else if (fn.type === "identifier") push("call", fn, node);
				}
				for (const c of node.namedChildren) if (c.id !== fn?.id) walk(c);
				if (fn && fn.type === "member_expression") {
					const obj = fn.childForFieldName("object");
					if (obj) walk(obj); // nested member/call chains inside the receiver
				} else if (fn && fn.type !== "identifier") {
					walk(fn); // IIFE, chained call, cast: refs inside the callee expression
				}
				return;
			}
			case "new_expression": {
				const ctor = node.childForFieldName("constructor");
				if (ctor) {
					const m = splitMember(ctor);
					if (m) push("new", m.token, node, { receiver: m.receiver });
					else if (ctor.type === "identifier") push("new", ctor, node);
				}
				for (const c of node.namedChildren) if (c.id !== ctor?.id) walk(c);
				if (ctor && ctor.type === "member_expression") {
					const obj = ctor.childForFieldName("object");
					if (obj) walk(obj);
				} else if (ctor && ctor.type !== "identifier") {
					walk(ctor);
				}
				return;
			}
			case "member_expression": {
				const m = splitMember(node);
				if (m) push("member", m.token, node, { receiver: m.receiver });
				const obj = node.childForFieldName("object");
				if (obj) walk(obj);
				return;
			}
			case "class_heritage": {
				// tree-sitter-javascript has no extends_clause: the heritage holds the expression directly.
				const hasClause = node.namedChildren.some((x) => x.type === "extends_clause" || x.type === "implements_clause");
				const jsBase = hasClause ? undefined : node.namedChildren[0];
				if (jsBase) {
					const m = splitMember(jsBase);
					if (m) push("extends", m.token, node, { receiver: m.receiver });
					else if (jsBase.type === "identifier") push("extends", jsBase, node);
					else typeIdentifiersAs("extends", jsBase, node);
					return;
				}
				for (const c of node.namedChildren) {
					if (c.type === "extends_clause") {
						const v = c.childForFieldName("value") ?? c.namedChildren[0];
						if (v) {
							const m = splitMember(v);
							if (m) push("extends", m.token, c, { receiver: m.receiver });
							else if (v.type === "identifier" || v.type === "type_identifier") push("extends", v, c);
							else typeIdentifiersAs("extends", v, c);
						}
						// type arguments on extends: Base<T>
						const ta = c.namedChildren.find((x) => x.type === "type_arguments");
						if (ta) typeIdentifiers(ta);
					} else if (c.type === "implements_clause") {
						for (const t of c.namedChildren) typeIdentifiersAs("implements", t, c);
					}
				}
				return;
			}
			case "extends_type_clause": {
				// interface A extends B
				for (const t of node.namedChildren) typeIdentifiersAs("extends", t, node);
				return;
			}
			case "type_annotation":
			case "type_arguments":
			case "type_parameters":
			case "as_expression":
			case "satisfies_expression":
			case "type_assertion":
			case "return_type":
			case "index_type_query":
			case "type_alias_declaration":
			case "interface_body":
			case "object_type":
			case "property_signature":
			case "method_signature":
			case "abstract_method_signature":
			case "generic_type":
			case "union_type":
			case "intersection_type":
			case "array_type":
			case "tuple_type":
			case "function_type":
			case "conditional_type":
			case "lookup_type":
			case "type_predicate":
			case "predefined_type":
			case "type_query": {
				if (node.type === "as_expression" || node.type === "satisfies_expression" || node.type === "type_assertion") {
					// expression part is a normal expression; the type part is a type position
					for (const c of node.namedChildren) {
						if (c.type.endsWith("_type") || c.type === "type_identifier" || c.type === "generic_type" || c.type === "nested_type_identifier" || c.type === "type_query") typeIdentifiers(c);
						else walk(c);
					}
					return;
				}
				if (node.type === "type_alias_declaration") {
					const v = node.childForFieldName("value");
					if (v) typeIdentifiers(v);
					const tp = node.childForFieldName("type_parameters");
					if (tp) typeIdentifiers(tp);
					return;
				}
				if (node.type === "method_signature" || node.type === "abstract_method_signature" || node.type === "property_signature") {
					for (const c of node.namedChildren) if (c.type !== "property_identifier") typeIdentifiers(c);
					return;
				}
				typeIdentifiers(node);
				return;
			}
			case "jsx_opening_element":
			case "jsx_self_closing_element": {
				const nameNode = node.childForFieldName("name");
				if (nameNode) {
					const m = splitMember(nameNode);
					if (m) push("jsx", m.token, node, { receiver: m.receiver });
					else if (nameNode.type === "identifier" && /^[A-Z]/.test(nameNode.text)) push("jsx", nameNode, node);
				}
				for (const c of node.namedChildren) if (c.id !== nameNode?.id) walk(c);
				return;
			}
			case "decorator": {
				const inner = node.namedChildren[0];
				if (inner) {
					if (inner.type === "identifier") push("decorator", inner, node);
					else if (inner.type === "call_expression") {
						const fn = inner.childForFieldName("function");
						if (fn) {
							const m = splitMember(fn);
							if (m) push("decorator", m.token, node, { receiver: m.receiver });
							else if (fn.type === "identifier") push("decorator", fn, node);
						}
						const args = inner.childForFieldName("arguments");
						if (args) walk(args);
					} else if (inner.type === "member_expression") {
						const m = splitMember(inner);
						if (m) push("decorator", m.token, node, { receiver: m.receiver });
					}
				}
				return;
			}
		}
		for (const c of node.children) walk(c);
	}

	function typeIdentifiersAs(kind: "extends" | "implements", node: SyntaxNode, at: SyntaxNode): void {
		if (node.type === "type_identifier" || node.type === "identifier") {
			push(kind, node, at);
			return;
		}
		if (node.type === "generic_type") {
			const n = node.childForFieldName("name");
			if (n) typeIdentifiersAs(kind, n, at);
			const ta = node.childForFieldName("type_arguments");
			if (ta) typeIdentifiers(ta);
			return;
		}
		if (node.type === "nested_type_identifier") {
			const n = node.childForFieldName("name");
			const mod = node.childForFieldName("module");
			if (n) push(kind, n, at, mod ? { receiver: mod.text } : {});
			return;
		}
		if (node.type === "member_expression") {
			const m = splitMember(node);
			if (m) push(kind, m.token, at, { receiver: m.receiver });
			return;
		}
		for (const c of node.namedChildren) typeIdentifiersAs(kind, c, at);
	}

	walk(root);
	// Deterministic order: by position, then kind, so re-parses compare equal.
	refs.sort((a, b) => a.range.line - b.range.line || a.range.column - b.range.column || a.kind.localeCompare(b.kind));
	return { rawRefs: refs, reexports };
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
			if (!parser) return { symbols: [], rawCalls: [], rawRefs: [], reexports: [], importBindings: [] };
			const tree = parser.parse(source);
			if (!tree) return { symbols: [], rawCalls: [], rawRefs: [], reexports: [], importBindings: [] };
			const root = tree.rootNode;
			const symbols = extractSymbols(root, filePath);
			const { rawRefs, reexports } = extractRawRefs(root, filePath);
			return {
				symbols,
				rawCalls: extractRawCalls(root, filePath),
				rawRefs,
				reexports,
				importBindings: extractImportBindings(root),
			};
		},
	};
}
