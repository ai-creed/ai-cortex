// src/lib/symbol-resolver.ts
import path from "node:path";
import type { ImportBinding, ImportKind, RawRefSite } from "./lang-adapter.js";
import type { ImportEdge, RefEdge, ReexportRow, SymbolNode } from "./models.js";
import { symbolKey } from "./symbols.js";

// ---------- language / file-target helpers (moved from call-graph.ts) ----------

const TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const C_FAMILY_EXTS = new Set([
	".c",
	".cpp",
	".cc",
	".cxx",
	".c++",
	".h",
	".hpp",
	".hh",
	".hxx",
	".h++",
]);
const H_EXTS = new Set([".h", ".hh", ".hpp", ".hxx", ".h++"]);
const SRC_EXTS = [".cpp", ".cc", ".cxx", ".c++", ".c"];

export type Lang = "ts" | "cfamily" | "python" | "other";

export function langOf(filePath: string): Lang {
	const ext = path.extname(filePath);
	if (TS_EXTS.has(ext)) return "ts";
	if (C_FAMILY_EXTS.has(ext)) return "cfamily";
	if (ext === ".py") return "python";
	return "other";
}

export function stripTsExt(value: string): string {
	return value.replace(/\.(ts|tsx|js|jsx)$/u, "");
}

export function resolveSpecifier(
	fromSpecifier: string,
	fromFile: string,
): string {
	return path
		.normalize(path.join(path.dirname(fromFile), fromSpecifier))
		.replace(/\\/g, "/");
}

export function findTargetFile(
	normalizedSpecifier: string,
	knownFiles: Map<string, unknown>,
	lang: Lang,
): string | null {
	if (lang === "ts") {
		const stripped = stripTsExt(normalizedSpecifier);
		for (const file of knownFiles.keys())
			if (stripTsExt(file) === stripped) return file;
		for (const file of knownFiles.keys())
			if (stripTsExt(file) === `${stripped}/index`) return file;
		return null;
	}
	if (lang === "cfamily") {
		if (knownFiles.has(normalizedSpecifier)) return normalizedSpecifier;
		const baseName = path.basename(normalizedSpecifier);
		const matches: string[] = [];
		for (const file of knownFiles.keys())
			if (path.basename(file) === baseName) matches.push(file);
		return matches.length === 1 ? matches[0] : null;
	}
	return null;
}

export function resolvePythonTargetFile(
	fromSpecifier: string,
	fromFile: string,
	knownFiles: Map<string, unknown>,
	includesByFile: Map<string, ImportEdge[]>,
): string | null {
	const specPy = fromSpecifier + ".py";
	const specInit = fromSpecifier + "/__init__.py";
	const edges = includesByFile.get(fromFile) ?? [];
	const edge = edges.find(
		(e) =>
			e.to === specPy ||
			e.to === specInit ||
			e.to.endsWith("/" + specPy) ||
			e.to.endsWith("/" + specInit),
	);
	if (edge) return edge.to;
	if (knownFiles.has(specPy)) return specPy;
	if (knownFiles.has(specInit)) return specInit;
	return null;
}

export function companionSourceFiles(
	headerPath: string,
	known: Map<string, unknown>,
): string[] {
	const ext = path.extname(headerPath);
	if (!H_EXTS.has(ext)) return [];
	const base = headerPath.slice(0, -ext.length);
	return SRC_EXTS.map((e) => `${base}${e}`).filter((p) => known.has(p));
}

// ---------- symbol index ----------

export type SymbolIndex = {
	byFile: Map<string, Map<string, SymbolNode[]>>;
	files: Map<string, SymbolNode[]>;
	all: SymbolNode[];
};

export function buildSymbolIndex(symbols: SymbolNode[]): SymbolIndex {
	const byFile = new Map<string, Map<string, SymbolNode[]>>();
	const files = new Map<string, SymbolNode[]>();
	for (const s of symbols) {
		let m = byFile.get(s.file);
		if (!m) {
			m = new Map();
			byFile.set(s.file, m);
		}
		const list = m.get(s.qualifiedName) ?? [];
		list.push(s);
		m.set(s.qualifiedName, list);
		const fl = files.get(s.file) ?? [];
		fl.push(s);
		files.set(s.file, fl);
	}
	return { byFile, files, all: symbols };
}

export type ReexportTarget = { specifier: string; sourceName: string };
/** file -> exportedName -> target, or null when the same exported name is
 *  re-exported from more than one source (A5 ambiguity: leave unresolved). */
export type ReexportTable = Map<string, Map<string, ReexportTarget | null>>;

export function buildReexportTable(rows: ReexportRow[]): ReexportTable {
	const t: ReexportTable = new Map();
	for (const r of rows) {
		let m = t.get(r.file);
		if (!m) {
			m = new Map();
			t.set(r.file, m);
		}
		const prev = m.get(r.exportedName);
		if (prev === undefined) {
			m.set(r.exportedName, {
				specifier: r.specifier,
				sourceName: r.sourceName,
			});
		} else if (
			prev !== null &&
			(prev.specifier !== r.specifier || prev.sourceName !== r.sourceName)
		) {
			m.set(r.exportedName, null); // two different sources for one name: ambiguous
		}
	}
	return t;
}

/** A key exists in `file` for `qualifiedName` (rows sharing a key are one candidate). */
function keyIn(
	idx: SymbolIndex,
	file: string,
	qualifiedName: string,
): string | null {
	const rows = idx.byFile.get(file)?.get(qualifiedName);
	return rows && rows.length > 0 ? symbolKey(file, qualifiedName) : null;
}

function kindOf(
	idx: SymbolIndex,
	file: string,
	qualifiedName: string,
): SymbolNode["kind"] | null {
	const rows = idx.byFile.get(file)?.get(qualifiedName);
	if (!rows || rows.length === 0) return null;
	return (rows.find((r) => !r.isDeclarationOnly) ?? rows[0]).kind;
}

function defaultExportIn(idx: SymbolIndex, file: string): string | null {
	const rows = (idx.files.get(file) ?? []).filter((s) => s.isDefaultExport);
	const keys = new Set(rows.map((s) => symbolKey(s.file, s.qualifiedName)));
	return keys.size === 1 ? [...keys][0] : null;
}

/** Files a specifier may resolve to: files that declare symbols, files that
 *  only re-export (they declare nothing), and every endpoint of the import
 *  graph, so a re-export-only intermediary is still found. */
export function knownFilesFor(
	idx: SymbolIndex,
	reexports: ReexportTable,
	includesByFile: Map<string, ImportEdge[]>,
): Map<string, unknown> {
	const known = new Map<string, unknown>(idx.files);
	for (const f of reexports.keys()) if (!known.has(f)) known.set(f, true);
	for (const [from, edges] of includesByFile) {
		if (!known.has(from)) known.set(from, true);
		for (const e of edges) if (!known.has(e.to)) known.set(e.to, true);
	}
	return known;
}

export function targetFileFor(
	fromFile: string,
	specifier: string,
	known: Map<string, unknown>,
	includesByFile: Map<string, ImportEdge[]>,
): string | null {
	const lang = langOf(fromFile);
	if (lang === "python")
		return resolvePythonTargetFile(specifier, fromFile, known, includesByFile);
	return findTargetFile(resolveSpecifier(specifier, fromFile), known, lang);
}

/** Resolve `wanted` as an export of `file`, following at most one re-export hop. */
function exportOf(
	idx: SymbolIndex,
	file: string,
	wanted: string,
	reexports: ReexportTable,
	includesByFile: Map<string, ImportEdge[]>,
	known: Map<string, unknown>,
	hop: number,
): string | null {
	const direct = keyIn(idx, file, wanted);
	if (direct) return direct;
	if (hop >= 1) return null;
	const re = reexports.get(file)?.get(wanted);
	if (!re) return null; // absent, or null = ambiguous: both unresolved
	const next = targetFileFor(file, re.specifier, known, includesByFile);
	if (!next) return null;
	return exportOf(
		idx,
		next,
		re.sourceName,
		reexports,
		includesByFile,
		known,
		hop + 1,
	);
}

export type ResolveSite = {
	file: string;
	name: string;
	receiver?: string;
	enclosingClass?: string;
	specifier?: string;
	importKind?: ImportKind;
};

const SELF_RECEIVERS = new Set(["this", "self", "cls"]);

export function resolveName(
	idx: SymbolIndex,
	site: ResolveSite,
	bindings: ImportBinding[],
	reexports: ReexportTable,
	includesByFile: Map<string, ImportEdge[]>,
	known: Map<string, unknown> = knownFilesFor(idx, reexports, includesByFile),
): string | null {
	// Step 3a: import and export-from refs resolve directly by specifier.
	// `export { foo as bar } from "./x"` carries a specifier and no importKind: treat as named.
	if (site.specifier !== undefined) {
		const target = targetFileFor(
			site.file,
			site.specifier,
			known,
			includesByFile,
		);
		if (!target) return null;
		if (site.importKind === "namespace") return null;
		if (site.importKind === "default") return defaultExportIn(idx, target);
		return exportOf(
			idx,
			target,
			site.name,
			reexports,
			includesByFile,
			known,
			0,
		);
	}

	if (site.receiver !== undefined) {
		// Step 1: enclosing-class member.
		if (
			site.enclosingClass &&
			(SELF_RECEIVERS.has(site.receiver) ||
				site.receiver === site.enclosingClass ||
				// Source writes the short class name (`C.open()` inside N.C).
				site.enclosingClass.endsWith(`.${site.receiver}`))
		) {
			const hit = keyIn(idx, site.file, `${site.enclosingClass}.${site.name}`);
			if (hit) return hit;
			if (SELF_RECEIVERS.has(site.receiver)) return null; // inherited: fall through to unresolved
		}
		// Step 3b: receiver is an import binding.
		const binding = bindings.find((b) => b.localName === site.receiver);
		if (binding) {
			const target = targetFileFor(
				site.file,
				binding.fromSpecifier,
				known,
				includesByFile,
			);
			if (!target) return null;
			if (binding.bindingKind === "namespace")
				return exportOf(
					idx,
					target,
					site.name,
					reexports,
					includesByFile,
					known,
					0,
				);
			// Step 4 on an imported class/enum/namespace: Foo.bar
			const containerKey =
				binding.bindingKind === "default"
					? defaultExportIn(idx, target)
					: exportOf(
							idx,
							target,
							binding.importedName,
							reexports,
							includesByFile,
							known,
							0,
						);
			if (!containerKey) return null;
			const sep = containerKey.indexOf("::");
			const cFile = containerKey.slice(0, sep);
			const cQn = containerKey.slice(sep + 2);
			const k = kindOf(idx, cFile, cQn);
			if (k === "class" || k === "enum" || k === "namespace" || k === "struct")
				return keyIn(idx, cFile, `${cQn}.${site.name}`);
			return null;
		}
		// Step 4 on a same-file container.
		const k = kindOf(idx, site.file, site.receiver);
		if (k === "class" || k === "enum" || k === "namespace" || k === "struct")
			return keyIn(idx, site.file, `${site.receiver}.${site.name}`);
		return null;
	}

	// Step 2: same-file bare match (module scope only: no '.' in qualified name).
	const same = keyIn(idx, site.file, site.name);
	if (same) return same;

	// Step 3b: bare name is an import binding.
	const binding = bindings.find((b) => b.localName === site.name);
	if (binding) {
		const target = targetFileFor(
			site.file,
			binding.fromSpecifier,
			known,
			includesByFile,
		);
		if (!target) return null;
		if (binding.bindingKind === "default") return defaultExportIn(idx, target);
		if (binding.bindingKind === "namespace") return null;
		return exportOf(
			idx,
			target,
			binding.importedName,
			reexports,
			includesByFile,
			known,
			0,
		);
	}
	return null;
}

export function resolveRefs(
	rawRefs: RawRefSite[],
	symbols: SymbolNode[],
	bindingsByFile: Map<string, ImportBinding[]>,
	reexports: ReexportRow[],
	includesByFile: Map<string, ImportEdge[]>,
): RefEdge[] {
	const idx = buildSymbolIndex(symbols);
	const table = buildReexportTable(reexports);
	const known = knownFilesFor(idx, table, includesByFile);
	const out: RefEdge[] = [];
	for (const r of rawRefs) {
		const to = resolveName(
			idx,
			r,
			bindingsByFile.get(r.file) ?? [],
			table,
			includesByFile,
			known,
		);
		const edge: RefEdge = {
			file: r.file,
			name: r.name,
			kind: r.kind,
			range: r.range,
		};
		if (to) edge.to = to;
		if (
			r.enclosingQualifiedName &&
			keyIn(idx, r.file, r.enclosingQualifiedName)
		)
			edge.from = symbolKey(r.file, r.enclosingQualifiedName);
		out.push(edge);
	}
	return out;
}
