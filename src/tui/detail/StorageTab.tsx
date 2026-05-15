import React, { type JSX } from "react";
import { Box, Text } from "ink";
import type { CacheMeta } from "../../lib/stats/query.js";

export function StorageTab({
	repoKey,
	storage,
	meta,
}: {
	repoKey: string;
	storage: Record<string, number>;
	meta: CacheMeta;
}): JSX.Element {
	const bytes = storage[repoKey] ?? 0;
	if (bytes === 0 && !meta.indexedAt) return <Text>No storage data yet.</Text>;
	return (
		<Box flexDirection="column">
			<Text>cache size:  {(bytes / 1_000_000).toFixed(1)} MB</Text>
			<Text>indexed at:  {meta.indexedAt ?? "—"}</Text>
			<Text>fingerprint: {meta.fingerprint ?? "—"}</Text>
			<Text>file count:  {meta.fileCount ?? "—"}</Text>
		</Box>
	);
}
