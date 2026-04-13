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

export type FileExtractionResult = {
	functions: FunctionNode[];
	rawCalls: RawCallSite[];
	importBindings: ImportBinding[];
};

export interface LangAdapter {
	extensions: string[];
	extractFile(source: string, filePath: string): FileExtractionResult;
}
