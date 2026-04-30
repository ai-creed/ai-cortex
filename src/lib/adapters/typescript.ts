// src/lib/adapters/typescript.ts
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { FunctionNode } from "../models.js";
import type {
	LanguageAdapter,
	FileExtractionResult,
	RawCallData,
	RawCallSite,
	ImportBinding,
	RawImportSite,
} from "../lang-adapter.js";

// createRequire needed because repo is "type": "module" — no bare require()
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
		const tsGrammarPath = require.resolve(
			"tree-sitter-typescript/tree-sitter-typescript.wasm",
		);
		const tsxGrammarPath = require.resolve(
			"tree-sitter-typescript/tree-sitter-tsx.wasm",
		);
		// tree-sitter-javascript ships JS grammar (handles JSX too)
		const jsGrammarPath = require.resolve(
			"tree-sitter-javascript/tree-sitter-javascript.wasm",
		);

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

function extractFunctions(root: SyntaxNode, filePath: string): FunctionNode[] {
	const functions: FunctionNode[] = [];

	function walk(node: SyntaxNode, className: string | null, classExported: boolean): void {
		switch (node.type) {
			case "function_declaration": {
				const nameNode = node.childForFieldName("name");
				if (!nameNode) break;
				const isExport = node.parent?.type === "export_statement";
				const isDefault = isExport && node.parent?.children.some(
					(c: SyntaxNode) => c.type === "default",
				);
				functions.push({
					qualifiedName: nameNode.text,
					file: filePath,
					exported: !!isExport,
					isDefaultExport: !!isDefault,
					line: node.startPosition.row + 1,
				});
				break;
			}
			case "lexical_declaration": {
				// const foo = () => {} or const foo = function() {}
				const isExport = node.parent?.type === "export_statement";
				for (const declarator of node.children) {
					if (declarator.type !== "variable_declarator") continue;
					const nameNode = declarator.childForFieldName("name");
					const valueNode = declarator.childForFieldName("value");
					if (!nameNode || !valueNode) continue;
					if (
						valueNode.type === "arrow_function" ||
						valueNode.type === "function_expression"
					) {
						functions.push({
							qualifiedName: nameNode.text,
							file: filePath,
							exported: !!isExport,
							isDefaultExport: false,
							line: node.startPosition.row + 1,
						});
					}
				}
				break;
			}
			case "class_declaration": {
				const nameNode = node.childForFieldName("name");
				const name = nameNode?.text ?? null;
				const isExport = node.parent?.type === "export_statement";
				const isDefault = isExport && node.parent?.children.some(
					(c: SyntaxNode) => c.type === "default",
				);
				if (name) {
					functions.push({
						qualifiedName: name,
						file: filePath,
						exported: !!isExport,
						isDefaultExport: !!isDefault,
						line: node.startPosition.row + 1,
					});
				}
				// Walk class body for methods
				const body = node.childForFieldName("body");
				if (body && name) {
					walk(body, name, !!isExport);
					return; // Don't walk children again
				}
				break;
			}
			case "method_definition": {
				const nameNode = node.childForFieldName("name");
				if (!nameNode || !className) break;
				functions.push({
					qualifiedName: `${className}.${nameNode.text}`,
					file: filePath,
					exported: classExported,
					isDefaultExport: false,
					line: node.startPosition.row + 1,
				});
				break;
			}
			case "export_statement": {
				// Handle: export default () => {} and export default class Foo {}
				// Named exports are handled by the child node's own case
				const defaultToken = node.children.find((c: SyntaxNode) => c.type === "default");
				if (!defaultToken) break;
				const valueChild = node.children.find(
					(c: SyntaxNode) =>
						c.type === "arrow_function" ||
						c.type === "function_expression",
				);
				if (valueChild) {
					functions.push({
						qualifiedName: "default",
						file: filePath,
						exported: true,
						isDefaultExport: true,
						line: valueChild.startPosition.row + 1,
					});
					return; // Don't walk children — we handled it
				}
				break;
			}
		}

		for (const child of node.children) {
			walk(child, className, classExported);
		}
	}

	walk(root, null, false);
	return functions;
}

function findEnclosingFunction(
	node: SyntaxNode,
): string | null {
	let current = node.parent;
	while (current) {
		if (current.type === "method_definition") {
			const methodName = current.childForFieldName("name")?.text;
			const classNode = current.parent?.parent;
			const className =
				classNode?.type === "class_declaration"
					? classNode.childForFieldName("name")?.text
					: null;
			if (className && methodName) return `${className}.${methodName}`;
		}
		if (
			current.type === "function_declaration" ||
			current.type === "arrow_function" ||
			current.type === "function_expression"
		) {
			// For function_declaration, name is a direct child
			if (current.type === "function_declaration") {
				const name = current.childForFieldName("name")?.text;
				if (name) return name;
			}
			// For arrow/expression assigned to variable
			if (current.parent?.type === "variable_declarator") {
				const name = current.parent.childForFieldName("name")?.text;
				if (name) return name;
			}
		}
		current = current.parent;
	}
	return null;
}

function extractRawCalls(
	root: SyntaxNode,
	filePath: string,
): RawCallSite[] {
	const calls: RawCallSite[] = [];

	function walk(node: SyntaxNode): void {
		if (node.type === "call_expression") {
			const funcNode = node.childForFieldName("function");
			if (!funcNode) { walkChildren(node); return; }

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

			const caller = findEnclosingFunction(node);
			if (caller) {
				calls.push({
					callerQualifiedName: caller,
					callerFile: filePath,
					rawCallee,
					kind,
				});
			}
		} else if (node.type === "new_expression") {
			const ctorNode = node.childForFieldName("constructor");
			if (ctorNode) {
				const caller = findEnclosingFunction(node);
				if (caller) {
					calls.push({
						callerQualifiedName: caller,
						callerFile: filePath,
						rawCallee: ctorNode.text,
						kind: "new",
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
		capabilities: { importExtraction: true, callGraph: true, symbolIndex: false },
		async extractImports(worktreePath: string, filePath: string, content?: string): Promise<RawImportSite[]> {
			const source = content ?? await fs.promises.readFile(path.join(worktreePath, filePath), "utf8");
			return extractImportSitesFromSource(source, filePath);
		},
		async extractCallGraph(worktreePath: string, filePath: string, content?: string): Promise<RawCallData> {
			const source = content ?? await fs.promises.readFile(path.join(worktreePath, filePath), "utf8");
			const ext = path.extname(filePath);
			const parser = parserForExt(ext);
			if (!parser) return { functions: [], rawCalls: [], importBindings: [] };
			const tree = parser.parse(source);
			if (!tree) return { functions: [], rawCalls: [], importBindings: [] };
			const root = tree.rootNode;
			return {
				functions: extractFunctions(root, filePath),
				rawCalls: extractRawCalls(root, filePath),
				importBindings: extractImportBindings(root),
			};
		},
	};
}
