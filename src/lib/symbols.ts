// src/lib/symbols.ts
import type {
	FunctionNode,
	NavCapabilities,
	RefKind,
	SymbolKind,
	SymbolNode,
} from "./models.js";

export function symbolKey(file: string, qualifiedName: string): string {
	return `${file}::${qualifiedName}`;
}

const FUNCTION_KINDS = new Set<SymbolKind>(["function", "method", "class"]);

function toFunctionNode(s: SymbolNode): FunctionNode {
	return {
		qualifiedName: s.qualifiedName,
		file: s.file,
		exported: s.exported,
		isDefaultExport: s.isDefaultExport,
		line: s.range.line,
		column: s.range.column,
		endLine: s.range.endLine,
		endColumn: s.range.endColumn,
		isDeclarationOnly: s.isDeclarationOnly,
	};
}

/** A2.2: project symbols into functions, one row per key. Prefer the first
 *  non-declaration-only row in input (source) order, else the first
 *  declaration-only row. Output order is first-seen key order. */
export function functionsFromSymbols(symbols: SymbolNode[]): FunctionNode[] {
	const chosen = new Map<string, SymbolNode>();
	for (const s of symbols) {
		if (!FUNCTION_KINDS.has(s.kind)) continue;
		const key = symbolKey(s.file, s.qualifiedName);
		const prev = chosen.get(key);
		if (!prev) {
			chosen.set(key, s);
			continue;
		}
		if (prev.isDeclarationOnly && !s.isDeclarationOnly) chosen.set(key, s);
	}
	return [...chosen.values()].map(toFunctionNode);
}

// Static per-language kind declarations (B4: navCapabilities is the union of
// what the registered adapters can emit, not what one repo happened to contain).
export const TS_SYMBOL_KINDS: SymbolKind[] = [
	"function",
	"method",
	"class",
	"interface",
	"type",
	"enum",
	"enum_member",
	"variable",
	"property",
	"namespace",
];
export const TS_REF_KINDS: RefKind[] = [
	"call",
	"new",
	"type",
	"extends",
	"implements",
	"import",
	"export",
	"member",
	"jsx",
	"decorator",
];
export const PY_SYMBOL_KINDS: SymbolKind[] = [
	"function",
	"method",
	"class",
	"variable",
];
export const PY_REF_KINDS: RefKind[] = ["call", "import", "extends"];
export const C_SYMBOL_KINDS: SymbolKind[] = [
	"function",
	"method",
	"class",
	"struct",
	"enum",
	"enum_member",
	"type",
	"macro",
	"variable",
];
export const C_REF_KINDS: RefKind[] = ["call", "new"];

function union<T>(...lists: T[][]): T[] {
	const seen = new Set<T>();
	const out: T[] = [];
	for (const list of lists)
		for (const item of list)
			if (!seen.has(item)) {
				seen.add(item);
				out.push(item);
			}
	return out;
}

export function navCapabilities(): NavCapabilities {
	return {
		symbols: true,
		references: true,
		referencesTable: "refs",
		symbolKinds: union(TS_SYMBOL_KINDS, PY_SYMBOL_KINDS, C_SYMBOL_KINDS),
		referenceKinds: union(TS_REF_KINDS, PY_REF_KINDS, C_REF_KINDS),
	};
}
