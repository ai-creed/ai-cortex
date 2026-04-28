// src/lib/adapters/cfamily.ts
import { createRequire } from "node:module";
import * as path from "node:path";
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
  return `${parts.join("::")}::${leaf}`;
}

/** Return the namespace_identifier text for a namespace_definition node, or null. */
function namespaceIdentifier(node: SyntaxNode): string | null {
  for (const child of node.children) {
    if (child.type === "namespace_identifier") return child.text;
  }
  return null;
}

/** Return the type_identifier text for a class_specifier or struct_specifier node, or null. */
function classIdentifier(node: SyntaxNode): string | null {
  for (const child of node.children) {
    if (child.type === "type_identifier") return child.text;
  }
  return null;
}

function extractFunctions(root: SyntaxNode, filePath: string): FunctionNode[] {
  const fns: FunctionNode[] = [];

  function emit(
    name: string,
    node: SyntaxNode,
    isStatic: boolean,
    isDecl: boolean,
  ): void {
    fns.push({
      qualifiedName: name,
      file: filePath,
      exported: !isStatic,
      isDefaultExport: false,
      line: node.startPosition.row + 1,
      isDeclarationOnly: isDecl,
    });
  }

  function walk(node: SyntaxNode, nsStack: string[], className: string | null): void {
    if (node.type === "namespace_definition") {
      const nsName = namespaceIdentifier(node);
      const segs: string[] = [];
      if (nsName) {
        for (const part of nsName.split("::")) if (part) segs.push(part);
      }
      // The body of a namespace_definition is a declaration_list
      for (const child of node.children) {
        if (child.type === "declaration_list") {
          walk(child, [...nsStack, ...segs], className);
        }
      }
      return;
    }

    if (node.type === "class_specifier" || node.type === "struct_specifier") {
      const cls = classIdentifier(node);
      // The body is field_declaration_list
      for (const child of node.children) {
        if (child.type === "field_declaration_list") {
          walk(child, nsStack, cls ?? className);
        }
      }
      return;
    }

    if (node.type === "function_definition") {
      const declarator = node.childForFieldName("declarator");
      const fnDecl = declarator ? findFunctionDeclarator(declarator) : null;
      const inner = fnDecl?.childForFieldName("declarator");
      let name = inner ? declaratorName(inner) : null;
      if (name) {
        // If the name already contains "::" (out-of-line Foo::bar), respect it.
        // Otherwise, prepend className if inside a class body.
        if (!name.includes("::") && className) {
          name = `${className}::${name}`;
        }
        const fullName = joinQualified(nsStack, name);
        const isStatic = getStorageClass(node) === "static";
        emit(fullName, node, isStatic, false);
      }
      // Walk body for nested lambdas etc., but reset className context
      const body = node.childForFieldName("body");
      if (body) walk(body, nsStack, null);
      return;
    }

    // In-class declarations use "field_declaration" (not "declaration")
    if (node.type === "declaration" || node.type === "field_declaration") {
      const fnDecl = findFunctionDeclarator(node);
      if (fnDecl) {
        const inner = fnDecl.childForFieldName("declarator");
        // Skip function-pointer variables: int (*cmp)(...) has a pointer_declarator in the chain
        if (inner && hasPointerInChain(inner)) {
          for (const child of node.children) walk(child, nsStack, className);
          return;
        }
        let name = inner ? declaratorName(inner) : null;
        if (name) {
          if (!name.includes("::") && className) {
            name = `${className}::${name}`;
          }
          const fullName = joinQualified(nsStack, name);
          const isStatic = getStorageClass(node) === "static";
          emit(fullName, node, isStatic, true);
        }
      }
      // Don't recurse into declaration children to avoid double-emitting
      return;
    }

    for (const child of node.children) walk(child, nsStack, className);
  }

  walk(root, [], null);
  return fns;
}

function findEnclosingFunctionName(node: SyntaxNode): string | null {
  let cur: SyntaxNode | null = node.parent;
  while (cur) {
    if (cur.type === "function_definition") {
      const decl = cur.childForFieldName("declarator");
      const fnDecl = decl ? findFunctionDeclarator(decl) : null;
      const inner = fnDecl?.childForFieldName("declarator");
      let name = inner ? declaratorName(inner) : null;
      if (name) {
        // If the name already has "::", it's already fully qualified (out-of-line method)
        if (!name.includes("::")) {
          // Check for enclosing class
          let classNode: SyntaxNode | null = cur.parent;
          while (classNode) {
            if (
              classNode.type === "class_specifier" ||
              classNode.type === "struct_specifier"
            ) {
              const cls = classIdentifier(classNode);
              if (cls) name = `${cls}::${name}`;
              break;
            }
            if (
              classNode.type === "function_definition" ||
              classNode.type === "namespace_definition"
            )
              break;
            classNode = classNode.parent;
          }
        }
        // Collect outer namespaces
        const outerNs: string[] = [];
        let outer: SyntaxNode | null = cur.parent;
        while (outer) {
          if (outer.type === "namespace_definition") {
            const nsName = namespaceIdentifier(outer);
            if (nsName) {
              for (const seg of nsName.split("::").reverse()) {
                if (seg) outerNs.unshift(seg);
              }
            }
          }
          outer = outer.parent;
        }
        return outerNs.length > 0 ? `${outerNs.join("::")}::${name}` : name;
      }
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
