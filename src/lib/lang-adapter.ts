import type {
	FunctionNode,
	Range,
	RefKind,
	ReexportRow,
	SymbolKind,
	SymbolNode,
} from "./models.js";

export type RawCallSite = {
	callerQualifiedName: string;
	callerFile: string;
	rawCallee: string;
	kind: "call" | "new" | "method";
	site?: Range; // internal only, never serialized; mapped onto CallEdge.site by the resolver
	enclosingClass?: string; // fully qualified innermost enclosing class, e.g. "N.C" (A5 step 1)
};

export type ImportKind = "named" | "default" | "namespace";

export type RawRefSite = {
	file: string;
	name: string; // import: imported name (named) or local name (default/namespace); export-from: source name; else token text
	kind: RefKind;
	range: Range; // identifier token range
	receiver?: string; // `a` in `a.b`; "this" | "self" | "cls" allowed
	enclosingQualifiedName?: string; // enclosing indexed declaration, undefined at module scope
	enclosingClass?: string; // fully qualified innermost enclosing class
	specifier?: string; // import / export-from specifier text as written
	alias?: string; // import: local name when it differs; export-from: exported name when it differs
	importKind?: ImportKind; // kind "import" only
};

export type ImportBinding = {
	localName: string;
	importedName: string;
	fromSpecifier: string;
	bindingKind: ImportKind;
};

export type RawImportSite = {
	from: string;
	rawSpecifier: string;
	candidate: string;
};

export type FileExtractionResult = {
	functions: FunctionNode[];
	rawCalls: RawCallSite[];
	importBindings: ImportBinding[];
};

export type AdapterCapabilities = {
	importExtraction: boolean;
	callGraph: boolean;
	symbolIndex: boolean;
};

export type RawCallData = {
	functions: FunctionNode[]; // removed in Task 6; derived from symbols afterwards
	symbols?: SymbolNode[]; // required from Task 6
	rawCalls: RawCallSite[];
	rawRefs?: RawRefSite[]; // required from Task 6
	reexports?: ReexportRow[]; // required from Task 6
	importBindings: ImportBinding[];
};

export type LanguageAdapter = {
	extensions: string[];
	capabilities: AdapterCapabilities;
	symbolKinds: SymbolKind[]; // kinds this adapter can emit (navCapabilities)
	referenceKinds: RefKind[];
	extractImports(
		worktreePath: string,
		filePath: string,
		content?: string,
	): Promise<RawImportSite[]>;
	extractCallGraph?(
		worktreePath: string,
		filePath: string,
		content?: string,
	): Promise<RawCallData>;
};

// Backward-compatible alias. Existing code using LangAdapter continues to work.
export type LangAdapter = LanguageAdapter;
