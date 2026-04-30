import path from "node:path";
import type { LanguageAdapter, AdapterCapabilities } from "../lang-adapter.js";

const adapters: Map<string, LanguageAdapter> = new Map();

export function registerAdapter(adapter: LanguageAdapter): void {
	for (const ext of adapter.extensions) {
		adapters.set(ext, adapter);
	}
}

export function adapterForFile(filePath: string): LanguageAdapter | undefined {
	const ext = path.extname(filePath);
	if (!ext) return undefined;
	return adapters.get(ext);
}

export function getAdapterForFile(filePath: string): LanguageAdapter | null {
	return adapterForFile(filePath) ?? null;
}

export function adapterSupports(
	filePath: string,
	cap: keyof AdapterCapabilities,
): boolean {
	const adapter = getAdapterForFile(filePath);
	return adapter?.capabilities[cap] ?? false;
}

export function clearAdapters(): void {
	adapters.clear();
}

export function isAdapterExt(filePath: string): boolean {
	const ext = path.extname(filePath);
	if (!ext) return false;
	return adapters.has(ext);
}

export function adapterExtensions(): string[] {
	return Array.from(adapters.keys());
}
