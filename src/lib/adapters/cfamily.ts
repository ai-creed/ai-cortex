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

function extractFunctions(
  _root: SyntaxNode,
  _filePath: string,
): FunctionNode[] {
  return [];
}

function extractRawCalls(
  _root: SyntaxNode,
  _filePath: string,
): RawCallSite[] {
  return [];
}

function extractImportSitesFromRoot(
  _root: SyntaxNode,
  _filePath: string,
): RawImportSite[] {
  return [];
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
