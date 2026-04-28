// src/lib/adapters/cfamily.ts
import { createRequire } from "node:module";
import type {
  LangAdapter,
  FileExtractionResult,
  RawCallSite,
  RawImportSite,
} from "../lang-adapter.js";
import type { FunctionNode } from "../models.js";

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
    const cppGrammarPath = require.resolve(
      "tree-sitter-cpp/tree-sitter-cpp.wasm",
    );

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
  const name = declarator.childForFieldName("declarator");
  if (!name) {
    if (declarator.type === "identifier" || declarator.type === "field_identifier") {
      return declarator.text;
    }
    return null;
  }
  if (name.type === "identifier" || name.type === "field_identifier") return name.text;
  if (name.type === "qualified_identifier") return name.text;
  if (name.type === "destructor_name" || name.type === "operator_name") return name.text;
  return declaratorName(name);
}

function findFunctionDeclarator(node: SyntaxNode): SyntaxNode | null {
  if (node.type === "function_declarator") return node;
  for (const child of node.children) {
    const r = findFunctionDeclarator(child);
    if (r) return r;
  }
  return null;
}

function extractFunctions(root: SyntaxNode, filePath: string): FunctionNode[] {
  const fns: FunctionNode[] = [];

  function walk(node: SyntaxNode): void {
    if (node.type === "function_definition") {
      const declarator = node.childForFieldName("declarator");
      const fnDecl = declarator ? findFunctionDeclarator(declarator) : null;
      if (fnDecl) {
        const inner = fnDecl.childForFieldName("declarator");
        const name = inner ? declaratorName(inner) : null;
        if (name) {
          const isStatic = getStorageClass(node) === "static";
          fns.push({
            qualifiedName: name,
            file: filePath,
            exported: !isStatic,
            isDefaultExport: false,
            line: node.startPosition.row + 1,
            isDeclarationOnly: false,
          });
        }
      }
    } else if (node.type === "declaration") {
      const fnDecl = findFunctionDeclarator(node);
      if (fnDecl) {
        const inner = fnDecl.childForFieldName("declarator");
        const name = inner ? declaratorName(inner) : null;
        if (name) {
          const isStatic = getStorageClass(node) === "static";
          fns.push({
            qualifiedName: name,
            file: filePath,
            exported: !isStatic,
            isDefaultExport: false,
            line: node.startPosition.row + 1,
            isDeclarationOnly: true,
          });
        }
      }
    }

    for (const child of node.children) walk(child);
  }

  walk(root);
  return fns;
}

function findEnclosingFunctionName(node: SyntaxNode): string | null {
  let cur: SyntaxNode | null = node.parent;
  while (cur) {
    if (cur.type === "function_definition") {
      const decl = cur.childForFieldName("declarator");
      const fnDecl = decl ? findFunctionDeclarator(decl) : null;
      const inner = fnDecl?.childForFieldName("declarator");
      const name = inner ? declaratorName(inner) : null;
      if (name) return name;
    }
    cur = cur.parent;
  }
  return null;
}

function extractRawCalls(root: SyntaxNode, filePath: string): RawCallSite[] {
  const calls: RawCallSite[] = [];

  function walk(node: SyntaxNode): void {
    if (node.type === "call_expression") {
      const fnNode = node.childForFieldName("function");
      if (fnNode) {
        let rawCallee: string;
        let kind: RawCallSite["kind"];
        if (fnNode.type === "field_expression") {
          const obj = fnNode.childForFieldName("argument")?.text ?? "";
          const prop = fnNode.childForFieldName("field")?.text ?? "";
          rawCallee = `${obj}.${prop}`;
          kind = "method";
        } else {
          rawCallee = fnNode.text;
          kind = "call";
        }
        const caller = findEnclosingFunctionName(node);
        if (caller) {
          calls.push({
            callerQualifiedName: caller,
            callerFile: filePath,
            rawCallee,
            kind,
          });
        }
      }
    }
    if (node.type === "new_expression") {
      const typeNode =
        node.childForFieldName("type") ??
        node.childForFieldName("constructor") ??
        node.children.find((c: SyntaxNode) => c.type === "type_identifier");
      if (typeNode) {
        const caller = findEnclosingFunctionName(node);
        if (caller) {
          calls.push({
            callerQualifiedName: caller,
            callerFile: filePath,
            rawCallee: typeNode.text,
            kind: "new",
          });
        }
      }
    }
    for (const child of node.children) walk(child);
  }

  walk(root);
  return calls;
}

function extractImportSitesFromRoot(
  _root: SyntaxNode,
  _filePath: string,
): RawImportSite[] {
  return []; // Implemented in Task 13
}

function buildAdapter(
  exts: string[],
  parserGetter: () => import("web-tree-sitter").Parser | null,
): LangAdapter {
  return {
    extensions: exts,
    extractFile(source: string, filePath: string): FileExtractionResult {
      const parser = parserGetter();
      if (!parser) return { functions: [], rawCalls: [], importBindings: [] };
      const tree = parser.parse(source);
      if (!tree) return { functions: [], rawCalls: [], importBindings: [] };
      const root = tree.rootNode;
      return {
        functions: extractFunctions(root, filePath),
        rawCalls: extractRawCalls(root, filePath),
        importBindings: [],
      };
    },
    extractImportSites(source: string, filePath: string): RawImportSite[] {
      const parser = parserGetter();
      if (!parser) return [];
      const tree = parser.parse(source);
      if (!tree) return [];
      return extractImportSitesFromRoot(tree.rootNode, filePath);
    },
  };
}

export async function createCAdapter(): Promise<LangAdapter> {
  await initParsers();
  return buildAdapter([".c"], () => cParser);
}

export async function createCppAdapter(): Promise<LangAdapter> {
  await initParsers();
  return buildAdapter(CPP_EXTS, () => cppParser);
}
