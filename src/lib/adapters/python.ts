// src/lib/adapters/python.ts
import { createRequire } from "node:module";
import type {
  LangAdapter,
  FileExtractionResult,
  RawImportSite,
} from "../lang-adapter.js";
import type { FunctionNode } from "../models.js";

const require = createRequire(import.meta.url);

let pyParser: import("web-tree-sitter").Parser | null = null;
let initPromise: Promise<void> | null = null;

type SyntaxNode = import("web-tree-sitter").Node;

async function initParser(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const { Parser: TreeSitter, Language } = await import("web-tree-sitter");
    await TreeSitter.init();
    const grammarPath = require.resolve(
      "tree-sitter-python/tree-sitter-python.wasm",
    );
    const pyLang = await Language.load(grammarPath);
    pyParser = new TreeSitter();
    pyParser.setLanguage(pyLang);
  })();
  return initPromise;
}

function extractFunctions(root: SyntaxNode, filePath: string): FunctionNode[] {
  const fns: FunctionNode[] = [];

  function walk(node: SyntaxNode, className: string | null): void {
    switch (node.type) {
      case "function_definition": {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          fns.push({
            qualifiedName: className
              ? `${className}.${nameNode.text}`
              : nameNode.text,
            file: filePath,
            exported: true,
            isDefaultExport: false,
            line: node.startPosition.row + 1,
          });
        }
        return; // don't descend into function body — no nested extraction
      }
      case "decorated_definition": {
        const def = node.children.find(
          (c) =>
            c.type === "function_definition" || c.type === "class_definition",
        );
        if (def) walk(def, className);
        return;
      }
      case "class_definition": {
        const nameNode = node.childForFieldName("name");
        const cls = nameNode?.text ?? null;
        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.children) walk(child, cls);
        }
        return;
      }
      default:
        for (const child of node.children) walk(child, className);
    }
  }

  for (const child of root.children) walk(child, null);
  return fns;
}

export async function createPythonAdapter(): Promise<LangAdapter> {
  await initParser();
  return {
    extensions: [".py"],
    extractFile(source: string, filePath: string): FileExtractionResult {
      if (!pyParser) return { functions: [], rawCalls: [], importBindings: [] };
      let tree;
      try {
        tree = pyParser.parse(source);
      } catch {
        return { functions: [], rawCalls: [], importBindings: [] };
      }
      if (!tree) return { functions: [], rawCalls: [], importBindings: [] };
      try {
        return {
          functions: extractFunctions(tree.rootNode, filePath),
          rawCalls: [],
          importBindings: [],
        };
      } catch {
        return { functions: [], rawCalls: [], importBindings: [] };
      }
    },
    extractImportSites(_source: string, _filePath: string): RawImportSite[] {
      return [];
    },
  };
}
