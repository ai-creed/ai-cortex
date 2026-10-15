// src/lib/cache-store-sqlite.ts
import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type {
	RepoCache,
	FileNode,
	DocInput,
	ImportEdge,
	CallEdge,
	FunctionNode,
	SymbolNode,
	RefEdge,
	ReexportRow,
} from "./models.js";
import { SCHEMA_VERSION } from "./models.js";
import { checkpointAndVerify } from "./cache-store-migrate.js";
import { navCapabilities } from "./symbols.js";
import { readCanonicalIndexSeq, withSequenceLock } from "./seq-lock.js";

export const STORE_FORMAT_VERSION = 2;

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, kind TEXT NOT NULL, content_hash TEXT);
CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, title TEXT, body TEXT);
CREATE TABLE IF NOT EXISTS imports (from_path TEXT NOT NULL, to_path TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_imports_from ON imports(from_path);
CREATE TABLE IF NOT EXISTS functions (
  qualified_name TEXT NOT NULL, file TEXT NOT NULL, exported INTEGER,
  is_default_export INTEGER, line INTEGER, is_declaration_only INTEGER,
  col INTEGER, end_line INTEGER, end_col INTEGER, id TEXT
);
CREATE INDEX IF NOT EXISTS idx_fn_file_name ON functions(file, qualified_name);
CREATE TABLE IF NOT EXISTS calls (
  from_key TEXT NOT NULL, to_key TEXT NOT NULL, kind TEXT NOT NULL,
  site_line INTEGER, site_col INTEGER, site_end_line INTEGER, site_end_col INTEGER
);
CREATE INDEX IF NOT EXISTS idx_calls_to ON calls(to_key);
CREATE INDEX IF NOT EXISTS idx_calls_from ON calls(from_key);
CREATE TABLE IF NOT EXISTS symbols (
  key TEXT NOT NULL, file TEXT NOT NULL, qualified_name TEXT NOT NULL, name TEXT NOT NULL,
  kind TEXT NOT NULL, container_key TEXT, exported INTEGER NOT NULL, is_default_export INTEGER NOT NULL,
  is_declaration_only INTEGER NOT NULL, line INTEGER NOT NULL, col INTEGER NOT NULL,
  end_line INTEGER NOT NULL, end_col INTEGER NOT NULL, name_line INTEGER NOT NULL,
  name_col INTEGER NOT NULL, name_end_line INTEGER NOT NULL, name_end_col INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_symbols_key  ON symbols(key);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);
CREATE TABLE IF NOT EXISTS refs (
  file TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
  line INTEGER NOT NULL, col INTEGER NOT NULL, end_line INTEGER NOT NULL, end_col INTEGER NOT NULL,
  to_key TEXT, from_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_refs_to   ON refs(to_key);
CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(name);
CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file, line);
CREATE TABLE IF NOT EXISTS reexports (
  file TEXT NOT NULL, exported_name TEXT NOT NULL, source_name TEXT NOT NULL, specifier TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reexports_file ON reexports(file, exported_name);
`;

export function openStructuralDb(dbPath: string): DB {
	const db = new Database(dbPath);
	db.exec(SCHEMA_SQL);
	db.pragma(`user_version = ${STORE_FORMAT_VERSION}`);
	return db;
}

// Widened views for the nullable v3.1 forward-compat columns. On master these
// fields are absent (undefined -> stored as NULL); on the v3.1 branch they are
// present and carried through.
type FnExt = FunctionNode & {
	column?: number;
	endLine?: number;
	endColumn?: number;
	id?: string;
};
type CallSite = {
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
};
type CallExt = CallEdge & { site?: CallSite };

export function replaceAll(db: DB, cache: RepoCache): void {
	const tx = db.transaction(() => {
		db.exec(
			"DELETE FROM meta; DELETE FROM files; DELETE FROM docs; " +
				"DELETE FROM imports; DELETE FROM functions; DELETE FROM calls; " +
				"DELETE FROM symbols; DELETE FROM refs; DELETE FROM reexports;",
		);

		const metaIns = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
		metaIns.run("schemaVersion", cache.schemaVersion);
		metaIns.run("repoKey", cache.repoKey);
		metaIns.run("worktreeKey", cache.worktreeKey);
		metaIns.run("worktreePath", cache.worktreePath);
		metaIns.run("indexedAt", cache.indexedAt);
		metaIns.run("fingerprint", cache.fingerprint);
		if (cache.dirtyAtIndex !== undefined) {
			metaIns.run("dirtyAtIndex", cache.dirtyAtIndex ? "1" : "0");
		}
		metaIns.run("packageMeta", JSON.stringify(cache.packageMeta));
		metaIns.run("entryFiles", JSON.stringify(cache.entryFiles));
		metaIns.run("indexSeq", "0"); // B4 placeholder: only the sequence commit stamps the published value
		metaIns.run("contentFingerprint", cache.contentFingerprint ?? "");
		metaIns.run("navCapabilities", JSON.stringify(navCapabilities()));

		const fileIns = db.prepare(
			"INSERT INTO files (path, kind, content_hash) VALUES (@path, @kind, @content_hash)",
		);
		for (const f of cache.files) {
			fileIns.run({
				path: f.path,
				kind: f.kind,
				content_hash: f.contentHash ?? null,
			});
		}

		const docIns = db.prepare(
			"INSERT INTO docs (path, title, body) VALUES (@path, @title, @body)",
		);
		for (const d of cache.docs)
			docIns.run({ path: d.path, title: d.title, body: d.body });

		const impIns = db.prepare(
			"INSERT INTO imports (from_path, to_path) VALUES (@from_path, @to_path)",
		);
		for (const i of cache.imports)
			impIns.run({ from_path: i.from, to_path: i.to });

		const fnIns = db.prepare(
			"INSERT INTO functions (qualified_name, file, exported, is_default_export, line, " +
				"is_declaration_only, col, end_line, end_col, id) VALUES " +
				"(@qualified_name, @file, @exported, @is_default_export, @line, " +
				"@is_declaration_only, @col, @end_line, @end_col, @id)",
		);
		for (const fnRaw of cache.functions) {
			const fn = fnRaw as FnExt;
			fnIns.run({
				qualified_name: fn.qualifiedName,
				file: fn.file,
				exported: fn.exported ? 1 : 0,
				is_default_export: fn.isDefaultExport ? 1 : 0,
				line: fn.line,
				is_declaration_only:
					fn.isDeclarationOnly === undefined ? null : fn.isDeclarationOnly ? 1 : 0,
				col: fn.column ?? null,
				end_line: fn.endLine ?? null,
				end_col: fn.endColumn ?? null,
				id: fn.id ?? null,
			});
		}

		const callIns = db.prepare(
			"INSERT INTO calls (from_key, to_key, kind, site_line, site_col, site_end_line, site_end_col) " +
				"VALUES (@from_key, @to_key, @kind, @site_line, @site_col, @site_end_line, @site_end_col)",
		);
		for (const cRaw of cache.calls) {
			const c = cRaw as CallExt;
			callIns.run({
				from_key: c.from,
				to_key: c.to,
				kind: c.kind,
				site_line: c.site?.line ?? null,
				site_col: c.site?.column ?? null,
				site_end_line: c.site?.endLine ?? null,
				site_end_col: c.site?.endColumn ?? null,
			});
		}
		const symIns = db.prepare(
			"INSERT INTO symbols (key, file, qualified_name, name, kind, container_key, exported, is_default_export, is_declaration_only, line, col, end_line, end_col, name_line, name_col, name_end_line, name_end_col) VALUES " +
				"(@key, @file, @qualified_name, @name, @kind, @container_key, @exported, @is_default_export, @is_declaration_only, @line, @col, @end_line, @end_col, @name_line, @name_col, @name_end_line, @name_end_col)",
		);
		for (const s of cache.symbols) {
			symIns.run({
				key: `${s.file}::${s.qualifiedName}`,
				file: s.file,
				qualified_name: s.qualifiedName,
				name: s.name,
				kind: s.kind,
				container_key: s.containerQualifiedName ? `${s.file}::${s.containerQualifiedName}` : null,
				exported: s.exported ? 1 : 0,
				is_default_export: s.isDefaultExport ? 1 : 0,
				is_declaration_only: s.isDeclarationOnly ? 1 : 0,
				line: s.range.line,
				col: s.range.column,
				end_line: s.range.endLine,
				end_col: s.range.endColumn,
				name_line: s.nameRange.line,
				name_col: s.nameRange.column,
				name_end_line: s.nameRange.endLine,
				name_end_col: s.nameRange.endColumn,
			});
		}
		const refIns = db.prepare(
			"INSERT INTO refs (file, name, kind, line, col, end_line, end_col, to_key, from_key) VALUES (@file, @name, @kind, @line, @col, @end_line, @end_col, @to_key, @from_key)",
		);
		for (const r of cache.refs) {
			refIns.run({ file: r.file, name: r.name, kind: r.kind, line: r.range.line, col: r.range.column, end_line: r.range.endLine, end_col: r.range.endColumn, to_key: r.to ?? null, from_key: r.from ?? null });
		}
		const reIns = db.prepare("INSERT INTO reexports (file, exported_name, source_name, specifier) VALUES (@file, @exported_name, @source_name, @specifier)");
		for (const x of cache.reexports) {
			reIns.run({ file: x.file, exported_name: x.exportedName, source_name: x.sourceName, specifier: x.specifier });
		}
	});
	tx();
}

export type ReadOptions = {
	/** Load the navigation tables (`symbols`, `refs`, `reexports`). Defaults to
	 *  true. Read-only consumers (rehydrate, suggest, `index` on a fresh store)
	 *  pass false: those tables dominate the read cost and they never use them. */
	nav?: boolean;
};

// Caches assembled with `nav: false` carry empty nav arrays that do not reflect
// the store. They are tracked here, invisibly to equality and serialization, so
// a write-back cannot silently erase the published nav rows.
const navlessCaches = new WeakSet<RepoCache>();

/** True when the cache was read with `nav: false` and must never be written. */
export function isNavlessCache(cache: RepoCache): boolean {
	return navlessCaches.has(cache);
}

export function assembleCache(db: DB, options: ReadOptions = {}): RepoCache {
	const nav = options.nav ?? true;
	const metaRows = db.prepare("SELECT key, value FROM meta").all() as Array<{
		key: string;
		value: string;
	}>;
	const m = new Map(metaRows.map((r) => [r.key, r.value]));

	const files: FileNode[] = (
		db.prepare("SELECT path, kind, content_hash FROM files").all() as Array<{
			path: string;
			kind: string;
			content_hash: string | null;
		}>
	).map((r) => {
		const f: FileNode = { path: r.path, kind: r.kind as FileNode["kind"] };
		if (r.content_hash !== null) f.contentHash = r.content_hash;
		return f;
	});

	const docs: DocInput[] = (
		db.prepare("SELECT path, title, body FROM docs").all() as Array<{
			path: string;
			title: string;
			body: string;
		}>
	).map((r) => ({ path: r.path, title: r.title, body: r.body }));

	const imports: ImportEdge[] = (
		db.prepare("SELECT from_path, to_path FROM imports").all() as Array<{
			from_path: string;
			to_path: string;
		}>
	).map((r) => ({ from: r.from_path, to: r.to_path }));

	const functions: FunctionNode[] = (
		db.prepare("SELECT * FROM functions").all() as Array<{
			qualified_name: string;
			file: string;
			exported: number;
			is_default_export: number;
			line: number;
			is_declaration_only: number | null;
			col: number | null;
			end_line: number | null;
			end_col: number | null;
			id: string | null;
		}>
	).map((r) => {
		const fn: FunctionNode = {
			qualifiedName: r.qualified_name,
			file: r.file,
			exported: r.exported === 1,
			isDefaultExport: r.is_default_export === 1,
			line: r.line,
		};
		if (r.is_declaration_only !== null)
			fn.isDeclarationOnly = r.is_declaration_only === 1;
		const ext = fn as FnExt;
		if (r.col !== null) ext.column = r.col;
		if (r.end_line !== null) ext.endLine = r.end_line;
		if (r.end_col !== null) ext.endColumn = r.end_col;
		if (r.id !== null) ext.id = r.id;
		return fn;
	});

	const calls: CallEdge[] = (
		db.prepare("SELECT * FROM calls").all() as Array<{
			from_key: string;
			to_key: string;
			kind: string;
			site_line: number | null;
			site_col: number | null;
			site_end_line: number | null;
			site_end_col: number | null;
		}>
	).map((r) => {
		const c: CallEdge = {
			from: r.from_key,
			to: r.to_key,
			kind: r.kind as CallEdge["kind"],
		};
		if (r.site_line !== null) {
			(c as CallExt).site = {
				line: r.site_line,
				column: r.site_col as number,
				endLine: r.site_end_line as number,
				endColumn: r.site_end_col as number,
			};
		}
		return c;
	});

	const symbols: SymbolNode[] = !nav ? [] : (db.prepare("SELECT * FROM symbols ORDER BY rowid").all() as Array<{ file: string; qualified_name: string; name: string; kind: string; container_key: string | null; exported: number; is_default_export: number; is_declaration_only: number; line: number; col: number; end_line: number; end_col: number; name_line: number; name_col: number; name_end_line: number; name_end_col: number }>).map((r) => {
		const s: SymbolNode = {
			qualifiedName: r.qualified_name,
			name: r.name,
			file: r.file,
			kind: r.kind as SymbolNode["kind"],
			exported: r.exported === 1,
			isDefaultExport: r.is_default_export === 1,
			isDeclarationOnly: r.is_declaration_only === 1,
			range: { line: r.line, column: r.col, endLine: r.end_line, endColumn: r.end_col },
			nameRange: { line: r.name_line, column: r.name_col, endLine: r.name_end_line, endColumn: r.name_end_col },
		};
		if (r.container_key !== null) s.containerQualifiedName = r.container_key.slice(r.file.length + 2); // the container is always in the same file
		return s;
	});
	const refs: RefEdge[] = !nav ? [] : (db.prepare("SELECT * FROM refs ORDER BY rowid").all() as Array<{ file: string; name: string; kind: string; line: number; col: number; end_line: number; end_col: number; to_key: string | null; from_key: string | null }>).map((r) => {
		const e: RefEdge = { file: r.file, name: r.name, kind: r.kind as RefEdge["kind"], range: { line: r.line, column: r.col, endLine: r.end_line, endColumn: r.end_col } };
		if (r.to_key !== null) e.to = r.to_key;
		if (r.from_key !== null) e.from = r.from_key;
		return e;
	});
	const reexports: ReexportRow[] = !nav ? [] : (db.prepare("SELECT * FROM reexports ORDER BY rowid").all() as Array<{ file: string; exported_name: string; source_name: string; specifier: string }>).map((r) => ({ file: r.file, exportedName: r.exported_name, sourceName: r.source_name, specifier: r.specifier }));

	const cache: RepoCache = {
		schemaVersion: (m.get("schemaVersion") ?? "") as RepoCache["schemaVersion"],
		repoKey: m.get("repoKey") ?? "",
		worktreeKey: m.get("worktreeKey") ?? "",
		worktreePath: m.get("worktreePath") ?? "",
		indexedAt: m.get("indexedAt") ?? "",
		fingerprint: m.get("fingerprint") ?? "",
		packageMeta: JSON.parse(
			m.get("packageMeta") ?? "null",
		) as RepoCache["packageMeta"],
		entryFiles: JSON.parse(m.get("entryFiles") ?? "[]") as string[],
		files,
		docs,
		imports,
		calls,
		functions,
		indexSeq: Number(m.get("indexSeq") ?? "0"),
		contentFingerprint: m.get("contentFingerprint") ?? "",
		symbols,
		refs,
		reexports,
	};
	if (m.has("dirtyAtIndex")) cache.dirtyAtIndex = m.get("dirtyAtIndex") === "1";
	if (!nav) navlessCaches.add(cache);
	return cache;
}

export function majorOf(v: string): string {
	return v.split(".")[0] ?? "";
}

/** True iff the db's store format + exact schema version are current. Used to
 *  validate a db WITHOUT assembling the whole RepoCache. */
export function dbSchemaValid(dbPath: string): boolean {
	const db = new Database(dbPath, { readonly: true });
	try {
		if (db.pragma("user_version", { simple: true }) !== STORE_FORMAT_VERSION)
			return false;
		const row = db
			.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'")
			.get() as { value: string } | undefined;
		return (row?.value ?? "") === SCHEMA_VERSION;
	} finally {
		db.close();
	}
}

/** Open read-only, gate on store format + exact schema version, assemble. */
export function readFromDb(
	dbPath: string,
	options: ReadOptions = {},
): RepoCache | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		if (db.pragma("user_version", { simple: true }) !== STORE_FORMAT_VERSION)
			return null;
		const row = db
			.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'")
			.get() as { value: string } | undefined;
		if ((row?.value ?? "") !== SCHEMA_VERSION) return null;
		return assembleCache(db, options);
	} finally {
		db.close();
	}
}

type TranscodeHooks = { beforeLock?: () => void; afterRename?: () => void };
let transcodeTestHooks: TranscodeHooks | null = null;
/** Test-only seam: observe the point before the lock, or crash after the rename. */
export function setTranscodeTestHooks(h: TranscodeHooks | null): void {
	transcodeTestHooks = h;
}

/** Build a self-contained .db from a RepoCache via an OS-UNIQUE private build
 *  dir, then publish it under the sequence commit (spec B4): stamp the next
 *  indexSeq, checkpoint, and atomically rename over dbPath while holding the
 *  sidecar lock, so concurrent writers (processes or worker threads) publish
 *  distinct, strictly increasing values and readers only ever see a complete db. */
export function transcodeCacheToDb(cache: RepoCache, dbPath: string): void {
	if (navlessCaches.has(cache)) {
		throw new Error(
			"ai-cortex: refusing to write a cache read without its nav tables (readFromDb nav: false)",
		);
	}
	const dir = path.dirname(dbPath);
	fs.mkdirSync(dir, { recursive: true });
	// OS-unique build dir; no two attempts (threads or processes) can collide.
	const buildDir = fs.mkdtempSync(path.join(dir, ".transcode-"));
	const tmpDb = path.join(buildDir, "build.db");
	try {
		const db = openStructuralDb(tmpDb);
		try {
			replaceAll(db, cache); // writes indexSeq placeholder "0"
		} finally {
			db.close();
		}
		// B4 sequence commit: read, stamp, checkpoint, rename, commit, all under the sidecar lock.
		transcodeTestHooks?.beforeLock?.();
		const published = withSequenceLock(dbPath, (seq) => {
			const next = Math.max(seq.read(), readCanonicalIndexSeq(dbPath)) + 1;
			seq.write(next);
			const stamp = new Database(tmpDb);
			try {
				stamp.prepare("UPDATE meta SET value = ? WHERE key = 'indexSeq'").run(String(next));
			} finally {
				stamp.close();
			}
			// TRUNCATE-checkpoint and strip the build dir's -wal/-shm so a single file moves.
			checkpointAndVerify(tmpDb);
			fs.renameSync(tmpDb, dbPath); // same filesystem -> atomic
			transcodeTestHooks?.afterRename?.();
			return next;
		});
		cache.indexSeq = published;
	} finally {
		fs.rmSync(buildDir, { recursive: true, force: true });
	}
}
