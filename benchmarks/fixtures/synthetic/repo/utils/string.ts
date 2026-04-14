export function slugify(input: string): string {
	return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function truncate(input: string, maxLen: number): string {
	if (input.length <= maxLen) return input;
	return input.slice(0, maxLen - 3) + "...";
}
