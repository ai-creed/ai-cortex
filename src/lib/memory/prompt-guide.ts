// src/lib/memory/prompt-guide.ts
//
// Pure functions for installing/uninstalling the ai-cortex memory consultation
// rule into a Markdown file (CLAUDE.md or AGENTS.md). The block is wrapped in
// versioned HTML-comment markers so install/uninstall is idempotent and the
// rule content can be revised by bumping PROMPT_GUIDE_VERSION.

export const PROMPT_GUIDE_VERSION = "v1";

export const MEMORY_GUIDE_TEXT = `## Memory consultation (ai-cortex MCP)

This project uses ai-cortex's memory layer. Consult it to avoid repeating past mistakes and re-deriving past decisions.

**When to call:**
- Before non-trivial edits to unfamiliar files → \`recall_memory\` with \`scope.files\`
- When debugging recurring symptoms → \`recall_memory\` (no scope, broad query)
- When the user references a past decision → \`recall_memory\` keyed on the topic
- For cross-project patterns (language quirks, tool gotchas) → pass \`source: 'all'\`

**The cardinal pattern:** \`recall_memory\` is browse-only — it does not signal usage. After picking a relevant hit, call \`get_memory(id)\` to actually use it. That's the "I am applying this rule" signal that drives cleanup eligibility.

**When to write:** when the user states a rule, expresses a preference, or describes a constraint, call \`record_memory\` with \`scopeFiles\`/\`scopeTags\`. When a recalled memory contradicts current code or user direction, call \`deprecate_memory(id, reason)\`.`;

const START_MARKER_RE = /<!--\s*ai-cortex:memory-rule:start\s+(v\d+)\s*-->/;
const BLOCK_RE =
	/<!--\s*ai-cortex:memory-rule:start\s+v\d+\s*-->[\s\S]*?<!--\s*ai-cortex:memory-rule:end\s*-->/;
// Matches the block plus any leading/trailing newlines so we can clean-remove
// without leaving stray blank lines.
const BLOCK_WITH_PADDING_RE =
	/(?:\n+)?<!--\s*ai-cortex:memory-rule:start\s+v\d+\s*-->[\s\S]*?<!--\s*ai-cortex:memory-rule:end\s*-->\n*/;

function buildBlock(): string {
	return [
		`<!-- ai-cortex:memory-rule:start ${PROMPT_GUIDE_VERSION} -->`,
		MEMORY_GUIDE_TEXT,
		`<!-- ai-cortex:memory-rule:end -->`,
	].join("\n");
}

export function extractGuideVersion(text: string): string | null {
	const m = START_MARKER_RE.exec(text);
	return m ? m[1]! : null;
}

export function applyInstall(text: string): string {
	const block = buildBlock();
	if (BLOCK_RE.test(text)) {
		return text.replace(BLOCK_RE, block);
	}
	if (text.length === 0) return block + "\n";
	const sep = text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
	return text + sep + block + "\n";
}

export function applyUninstall(text: string): string {
	if (!BLOCK_RE.test(text)) return text;
	const out = text.replace(BLOCK_WITH_PADDING_RE, "\n");
	// Collapse multiple consecutive blank lines that may result, and strip
	// a leading newline if the block was at the very top.
	return out.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}
