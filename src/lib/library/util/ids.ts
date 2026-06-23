// src/lib/library/util/ids.ts
import { createHash } from "node:crypto";

// Stable 16-hex identity from ordered parts. Mirrors repo-identity's sha16 idiom.
export function hashId(...parts: string[]): string {
	return createHash("sha256")
		.update(parts.join("\0"))
		.digest("hex")
		.slice(0, 16);
}

// Full sha256 of document content. Used for change detection and rename relink,
// where low collision risk matters more than brevity.
export function hashContent(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}
