import type { FunctionNode } from "./models.js";

export type RawCallSite = {
	callerQualifiedName: string;
	callerFile: string;
	rawCallee: string;
	kind: "call" | "new" | "method";
};

export type ImportBinding = {
	localName: string;
	importedName: string;
	fromSpecifier: string;
	bindingKind: "named" | "default" | "namespace";
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
	functions: FunctionNode[];
	rawCalls: RawCallSite[];
	importBindings: ImportBinding[];
};

export type LanguageAdapter = {
	extensions: string[];
	capabilities: AdapterCapabilities;
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

// Backward-compatible alias — existing code using LangAdapter continues to work.
export type LangAdapter = LanguageAdapter;
