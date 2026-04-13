import path from "node:path";
import type { LangAdapter } from "../lang-adapter.js";

const adapters: Map<string, LangAdapter> = new Map();

export function registerAdapter(adapter: LangAdapter): void {
	for (const ext of adapter.extensions) {
		adapters.set(ext, adapter);
	}
}

export function adapterForFile(filePath: string): LangAdapter | undefined {
	const ext = path.extname(filePath);
	if (!ext) return undefined;
	return adapters.get(ext);
}

export function clearAdapters(): void {
	adapters.clear();
}
