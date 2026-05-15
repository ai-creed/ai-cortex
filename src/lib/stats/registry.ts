// src/lib/stats/registry.ts
import { openSink, type StatsSink } from "./sink.js";

const sinks = new Map<string, StatsSink>();

export function getSink(repoKey: string): StatsSink {
	const existing = sinks.get(repoKey);
	if (existing) return existing;
	const s = openSink(repoKey);
	sinks.set(repoKey, s);
	return s;
}

export function closeAllSinks(): void {
	for (const s of sinks.values()) {
		try {
			s.close();
		} catch {
			/* swallow */
		}
	}
	sinks.clear();
}
