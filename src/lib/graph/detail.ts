// src/lib/graph/detail.ts
import fs from "node:fs";
import { getCacheDir } from "../cache-store.js";
import { openRetrieve } from "../memory/retrieve.js";

export type NodeDetail = {
	id: string;
	kind: string;
	repoKey: string;
	label: string;
	fields: Record<string, unknown>;
};

// id forms: project:<repoKey>, dir:<repoKey>:<dir>, file:<repoKey>:<path>,
// symbol:<repoKey>:<file>::<qn>, memory:<repoKey>:<id>
export function parseNodeId(
	id: string,
): { kind: string; repoKey: string; rest: string } | null {
	const firstColon = id.indexOf(":");
	if (firstColon < 0) return null;
	const kind = id.slice(0, firstColon);
	const after = id.slice(firstColon + 1);
	const secondColon = after.indexOf(":");
	if (kind === "project" || secondColon < 0) {
		return { kind, repoKey: after, rest: "" };
	}
	return {
		kind,
		repoKey: after.slice(0, secondColon),
		rest: after.slice(secondColon + 1),
	};
}

function splitSymbol(rest: string): Record<string, unknown> {
	const i = rest.indexOf("::");
	return i < 0
		? { name: rest }
		: { file: rest.slice(0, i), name: rest.slice(i + 2) };
}

export function loadNodeDetail(id: string): NodeDetail | null {
	const parsed = parseNodeId(id);
	if (!parsed) return null;
	const { kind, repoKey, rest } = parsed;

	if (kind === "memory") {
		if (!fs.existsSync(`${getCacheDir(repoKey)}/memory/index.sqlite`)) return null;
		const rh = openRetrieve(repoKey);
		try {
			const row = rh.index.getMemory(rest);
			if (!row) return null;
			return {
				id,
				kind,
				repoKey,
				label: row.title,
				fields: {
					type: row.type,
					status: row.status,
					excerpt: row.body_excerpt,
				},
			};
		} finally {
			rh.close();
		}
	}

	// file / dir / symbol / project: detail is derivable from the id itself.
	return {
		id,
		kind,
		repoKey,
		label: rest || repoKey,
		fields: kind === "symbol" ? splitSymbol(rest) : { path: rest },
	};
}
