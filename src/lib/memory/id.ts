// src/lib/memory/id.ts
import crypto from "node:crypto";

const SLUG_CAP = 40;
const HEX_LEN = 6;

export function deriveSlug(title: string): string {
	const cleaned = title
		.toLowerCase()
		.replace(/[^\w\s-]+/g, " ")
		.replace(/[_\s]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");

	if (cleaned.length === 0) return "memory";

	if (cleaned.length <= SLUG_CAP) return cleaned;

	const truncated = cleaned.slice(0, SLUG_CAP);
	const lastDash = truncated.lastIndexOf("-");
	if (lastDash >= 20) return truncated.slice(0, lastDash);
	return truncated.replace(/-+$/, "");
}

function utcDateString(d: Date): string {
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

export function generateMemoryId(title: string, now: Date = new Date()): string {
	const slug = deriveSlug(title);
	const date = utcDateString(now);
	const hex = crypto.randomBytes(Math.ceil(HEX_LEN / 2)).toString("hex").slice(0, HEX_LEN);
	return `mem-${date}-${slug}-${hex}`;
}
