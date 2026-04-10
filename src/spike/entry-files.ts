export function scoreEntryFilePath(filePath: string): number {
	if (filePath === "electron/main/index.ts") return 100;
	if (filePath === "src/main.ts" || filePath === "src/main.tsx") return 95;
	if (filePath === "src/app/App.ts" || filePath === "src/app/App.tsx") return 92;
	if (filePath.startsWith("electron/main/")) return 80;
	if (filePath.startsWith("src/app/")) return 70;
	if (filePath.startsWith("services/")) return 65;
	if (filePath.startsWith("shared/")) return 60;
	if (filePath.startsWith("src/features/")) return 50;
	if (filePath === "package.json") return 40;
	return 0;
}

function unique<T>(items: T[]): T[] {
	return items.filter((value, index, arr) => arr.indexOf(value) === index);
}

export function pickPriorityFiles(filePaths: string[], limit = 6): string[] {
	return unique(filePaths)
		.map(filePath => ({ path: filePath, score: scoreEntryFilePath(filePath) }))
		.filter(item => item.score > 0)
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
		.slice(0, limit)
		.map(item => item.path);
}
