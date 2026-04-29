// src/lib/adapters/python.ts
import path from "node:path";
import { createRequire } from "node:module";
import type {
  LangAdapter,
  FileExtractionResult,
  RawCallSite,
  RawImportSite,
  ImportBinding,
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

function findEnclosingFunction(
  node: SyntaxNode,
): { name: string; className: string | null } | null {
  let cur: SyntaxNode | null = node.parent;
  while (cur) {
    if (cur.type === "function_definition") {
      const nameNode = cur.childForFieldName("name");
      if (!nameNode) return null;
      // Walk up to find enclosing class (skip decorated_definition wrapper)
      let p: SyntaxNode | null = cur.parent;
      while (p && p.type !== "module") {
        if (p.type === "class_definition") {
          return {
            name: nameNode.text,
            className: p.childForFieldName("name")?.text ?? null,
          };
        }
        p = p.parent;
      }
      return { name: nameNode.text, className: null };
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
            if ((obj === "self" || obj === "cls") && enclosing.className) {
              rawCallee = `${enclosing.className}.${attr}`;
              kind = "method";
            } else {
              rawCallee = `${obj}.${attr}`;
              kind = "method";
            }
          } else {
            rawCallee = fnNode.text;
            kind = "call";
          }
          calls.push({ callerQualifiedName, callerFile: filePath, rawCallee, kind });
        }
      }
    }
    for (const child of node.children) walk(child);
  }

  walk(root);
  return calls;
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
          rawCalls: extractRawCalls(tree.rootNode, filePath),
          importBindings: extractImportBindings(tree.rootNode, filePath),
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
