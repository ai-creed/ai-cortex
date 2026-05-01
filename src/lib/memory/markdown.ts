import yaml from "js-yaml";
import type { MemoryFrontmatter, MemoryRecord } from "./types.js";

const DELIM = "---";
const EXCERPT_CAP = 280;

export function serializeMemoryMarkdown(record: MemoryRecord): string {
	const fm = yaml.dump(record.frontmatter, {
		lineWidth: 120,
		noRefs: true,
		quotingType: '"',
	});
	return `${DELIM}\n${fm}${DELIM}\n${record.body}`;
}

export function parseMemoryMarkdown(text: string): MemoryRecord {
	if (!text.startsWith(`${DELIM}\n`)) {
		throw new Error("missing frontmatter block — file must start with '---'");
	}
	const endIdx = text.indexOf(`\n${DELIM}\n`, DELIM.length + 1);
	if (endIdx < 0) {
		throw new Error("unterminated frontmatter block");
	}
	const fmText = text.slice(DELIM.length + 1, endIdx);
	const body = text.slice(endIdx + DELIM.length + 2);
	const obj = yaml.load(fmText) as Record<string, unknown>;
	if (!obj || typeof obj !== "object") {
		throw new Error("frontmatter is not an object");
	}
	const fm: MemoryFrontmatter = {
		...(obj as MemoryFrontmatter),
		rewrittenAt: typeof obj.rewrittenAt === "string" ? obj.rewrittenAt : null,
	};
	return { frontmatter: fm, body };
}

export function bodyExcerpt(body: string): string {
	const trimmed = body.trim();
	if (trimmed.length <= EXCERPT_CAP) return trimmed;
	return (
		trimmed
			.slice(0, EXCERPT_CAP - 1)
			.replace(/\s+\S*$/, "")
			.trimEnd() + "…"
	);
}
