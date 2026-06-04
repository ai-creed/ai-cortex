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
} from "./models.js";
import { SCHEMA_VERSION } from "./models.js";
import { checkpointAndVerify } from "./cache-store-migrate.js";

export const STORE_FORMAT_VERSION = 1;

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
				"DELETE FROM imports; DELETE FROM functions; DELETE FROM calls;",
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
	});
	tx();
}

export function assembleCache(db: DB): RepoCache {
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
	};
	if (m.has("dirtyAtIndex")) cache.dirtyAtIndex = m.get("dirtyAtIndex") === "1";
	return cache;
}

export function majorOf(v: string): string {
	return v.split(".")[0] ?? "";
}

/** True iff the db's store format + content major version are current. Used to
 *  validate a db WITHOUT assembling the whole RepoCache. */
export function dbSchemaValid(dbPath: string): boolean {
	const db = new Database(dbPath, { readonly: true });
	try {
		if (db.pragma("user_version", { simple: true }) !== STORE_FORMAT_VERSION)
			return false;
		const row = db
			.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'")
			.get() as { value: string } | undefined;
		return majorOf(row?.value ?? "") === majorOf(SCHEMA_VERSION);
	} finally {
		db.close();
	}
}

/** Open read-only, gate on store format + content major version, assemble. */
export function readFromDb(dbPath: string): RepoCache | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		if (db.pragma("user_version", { simple: true }) !== STORE_FORMAT_VERSION)
			return null;
		const row = db
			.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'")
			.get() as { value: string } | undefined;
		if (majorOf(row?.value ?? "") !== majorOf(SCHEMA_VERSION)) return null;
		return assembleCache(db);
	} finally {
		db.close();
	}
}

/** Build a self-contained .db from a RepoCache via an OS-UNIQUE private build
 *  dir + checkpoint + atomic rename. Safe under concurrent transcodes of the
 *  same worktree (multiple processes OR worker threads): `fs.mkdtempSync`
 *  guarantees a distinct directory per attempt with no reliance on pid/threadId/
 *  counters, then the single-file rename over dbPath is atomic on POSIX
 *  (last-writer-wins; readers only ever see a complete db). */
export function transcodeCacheToDb(cache: RepoCache, dbPath: string): void {
	const dir = path.dirname(dbPath);
	fs.mkdirSync(dir, { recursive: true });
	// OS-unique build dir; no two attempts (threads or processes) can collide.
	const buildDir = fs.mkdtempSync(path.join(dir, ".transcode-"));
	const tmpDb = path.join(buildDir, "build.db");
	try {
		const db = openStructuralDb(tmpDb);
		try {
			replaceAll(db, cache);
		} finally {
			db.close();
		}
		// TRUNCATE-checkpoint and strip the build dir's -wal/-shm so a single file moves.
		checkpointAndVerify(tmpDb);
		fs.renameSync(tmpDb, dbPath); // same filesystem -> atomic
	} finally {
		fs.rmSync(buildDir, { recursive: true, force: true });
	}
}
