// src/lib/library/indexer.ts
import fs from "node:fs";
import path from "node:path";
import { chunkDoc } from "./doc-chunker.js";
import { walkDocs } from "./doc-walker.js";
import { readManifest, writeManifest } from "./manifest.js";
import { LibraryAnnotationStore } from "./store/annotation-store.js";
import {
	LibraryIndexStore,
	removeSourceIndexFile,
} from "./store/index-store.js";
import type { Embedder, Passage, SourceRecord } from "./types.js";
import { hashContent, hashId } from "./util/ids.js";
import { deriveDocType, parseStatusHeader } from "./value.js";

export async function indexSource(
	source: SourceRecord,
	embedder: Embedder,
): Promise<{
	docsIndexed: number;
	docsDeleted: number;
	passages: number;
	modelChanged: boolean;
}> {
	// A missing or unreadable source root is an error, not an empty index. The
	// caller (reindexLibrary) catches this and marks the source errored.
	try {
		if (!fs.statSync(source.rootPath).isDirectory())
			throw new Error("not a directory");
	} catch {
		throw new Error(
			`library source root missing or unreadable: ${source.rootPath}`,
		);
	}

	let manifest = readManifest(source.id);
	let modelChanged = false;
	if (
		manifest &&
		(manifest.modelId !== embedder.modelId || manifest.dim !== embedder.dim)
	) {
		// Vectors from a different model are never mixed; drop and rebuild.
		removeSourceIndexFile(source.id);
		manifest = null;
		modelChanged = true;
	}
	if (!manifest)
		manifest = { modelId: embedder.modelId, dim: embedder.dim, files: {} };

	// Open the index, recovering from a corrupt OR locked index.sqlite by dropping
	// it and rebuilding from source. Annotations live in a separate file and are
	// never touched, so they survive the rebuild (re-attached by stable docId).
	let store: LibraryIndexStore;
	try {
		store = LibraryIndexStore.open(source.id, embedder.dim);
		store.probeIntegrity(); // throws on a malformed (corrupt) OR persistently locked db
	} catch {
		removeSourceIndexFile(source.id);
		manifest = { modelId: embedder.modelId, dim: embedder.dim, files: {} };
		store = LibraryIndexStore.open(source.id, embedder.dim);
	}
	const anno = LibraryAnnotationStore.open(source.id);
	let docsIndexed = 0;
	let docsDeleted = 0;
	let passages = 0;

	try {
		const { files: relPaths, skipped } = await walkDocs(source.rootPath, {
			includeGlobs: source.includeGlobs,
			excludeGlobs: source.excludeGlobs,
		});
		if (skipped.length > 0) {
			// Record the reason for each skipped invalid file (spec edge case).
			process.stderr.write(
				`[library] ${source.origin.name}: skipped ${skipped.length} file(s): ` +
					skipped.map((s) => `${s.relPath} (${s.reason})`).join(", ") +
					"\n",
			);
		}
		const present = new Set(relPaths);

		// Deletions: files in the manifest but no longer on disk. Defer the annotation
		// relink decision until after we know which new paths appeared.
		const deletedPaths = Object.keys(manifest.files).filter(
			(rel) => !present.has(rel),
		);
		const deletedByHash = new Map<string, string>(); // contentHash -> old relPath
		for (const rel of deletedPaths) {
			deletedByHash.set(manifest.files[rel]!.contentHash, rel);
		}

		for (const rel of relPaths) {
			const abs = path.join(source.rootPath, rel);
			let content: string;
			let mtimeMs: number;
			try {
				const st = fs.statSync(abs);
				mtimeMs = st.mtimeMs;
				content = fs.readFileSync(abs, "utf8");
			} catch {
				continue; // unreadable file; skip without crashing the build
			}
			const contentHash = hashContent(content);
			const prev = manifest.files[rel];
			if (prev && prev.completed && prev.contentHash === contentHash) {
				continue; // unchanged; skip rework
			}

			const docId = hashId(source.id, rel);

			// Rename relink: this is a new path whose content matches a just-deleted path.
			if (!prev && deletedByHash.has(contentHash)) {
				const oldRel = deletedByHash.get(contentHash)!;
				const oldDocId = hashId(source.id, oldRel);
				anno.relink(oldDocId, docId);
				deletedByHash.delete(contentHash);
			}

			const chunks = chunkDoc(content);
			const texts = chunks.map((c) => c.text);
			const vectors = texts.length > 0 ? await embedder.embed(texts) : [];
			const docType = deriveDocType(rel);
			const statusHeader = parseStatusHeader(content) ?? null;

			const withVectors = chunks.map((c, i) => {
				const passage: Passage = { ...c, docId, contentHash };
				return { passage, vector: vectors[i]! };
			});
			store.replaceDoc(
				{
					docId,
					relPath: rel,
					docType,
					statusHeader,
					mtimeMs,
					pinned: 0,
					contentHash,
				},
				withVectors,
			);
			passages += withVectors.length;
			docsIndexed++;
			manifest.files[rel] = { contentHash, mtimeMs, completed: true };
			writeManifest(source.id, manifest); // resumable after each file
		}

		// Purge deleted docs (those not consumed by a relink stay deleted).
		for (const rel of deletedPaths) {
			store.deleteDoc(hashId(source.id, rel));
			delete manifest.files[rel];
			docsDeleted++;
		}
		writeManifest(source.id, manifest);
	} finally {
		store.close();
		anno.close();
	}

	return { docsIndexed, docsDeleted, passages, modelChanged };
}
