// src/lib/memory/legacy-scope.ts
//
// Pure parser for legacy memory-body TERMINAL trailer fragments. Older agent
// sessions emitted scope info as inline tags appended at the END of the
// markdown body rather than into YAML frontmatter, leaving frontmatter scope
// empty and the file unsurfaceable by the edit-time hook. `reconcileStore`
// consults this parser to canonicalize such files in place.
//
// Trailer-line shapes recognized (each must occupy its own line, possibly with
// surrounding whitespace):
//   <scopeFiles>...</scopeFiles>
//   <scopeTags>...</scopeTags>
//   <source>...</source>
//   <confidence>...</confidence>
//   <globalScope>...</globalScope>
//   </invoke>      ← stray tool-call leak
//
// The trailer block is the longest suffix of the body where every non-blank
// line matches one of the patterns above. Tag mentions anywhere else in the
// body (mid-paragraph, inside fenced code blocks, followed by more prose) are
// PRESERVED — we never delete user content.

export type LegacyScopeParseResult = {
	matched: boolean;
	scopeFiles: string[];
	scopeTags: string[];
	strippedBody: string;
};

const TRAILER_LINE_PATTERNS: ReadonlyArray<RegExp> = [
	/^\s*<scopeFiles>.*?<\/scopeFiles>\s*$/,
	/^\s*<scopeTags>.*?<\/scopeTags>\s*$/,
	/^\s*<source>.*?<\/source>\s*$/,
	/^\s*<confidence>.*?<\/confidence>\s*$/,
	/^\s*<globalScope>.*?<\/globalScope>\s*$/,
	/^\s*<\/invoke>\s*$/,
];

const SCOPE_FILES_RE = /<scopeFiles>([\s\S]*?)<\/scopeFiles>/;
const SCOPE_TAGS_RE = /<scopeTags>([\s\S]*?)<\/scopeTags>/;

function dedupTrim(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const v of values) {
		const t = v.trim();
		if (t === "" || seen.has(t)) continue;
		seen.add(t);
		out.push(t);
	}
	return out;
}

function parsePayload(raw: string): string[] {
	const trimmed = raw.trim();
	if (trimmed === "") return [];
	// If the payload looks like JSON (starts with `[` or `{`), require a valid
	// JSON-array-of-strings; on any failure return [] rather than falling back
	// to comma-split, which would produce garbage like ["{not valid"].
	if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
				return dedupTrim(parsed as string[]);
			}
		} catch {
			/* fall through to [] */
		}
		return [];
	}
	// Plain-text payload → comma-separated values.
	return dedupTrim(
		trimmed
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
}

function isTrailerLine(line: string): boolean {
	return TRAILER_LINE_PATTERNS.some((p) => p.test(line));
}

export function parseLegacyScopeTrailer(body: string): LegacyScopeParseResult {
	const lines = body.split("\n");

	// Walk from end. Blank lines are allowed inside the trailer block (don't
	// break the scan, don't move the boundary). A trailer line moves the
	// boundary. Any other non-blank line terminates the scan.
	let boundary = lines.length;
	let foundTrailer = false;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (line.trim() === "") continue;
		if (isTrailerLine(line)) {
			boundary = i;
			foundTrailer = true;
			continue;
		}
		break;
	}

	if (!foundTrailer) {
		return {
			matched: false,
			scopeFiles: [],
			scopeTags: [],
			strippedBody: body,
		};
	}

	const trailer = lines.slice(boundary).join("\n");
	const filesMatch = trailer.match(SCOPE_FILES_RE);
	const tagsMatch = trailer.match(SCOPE_TAGS_RE);
	const scopeFiles = filesMatch ? parsePayload(filesMatch[1]) : [];
	const scopeTags = tagsMatch ? parsePayload(tagsMatch[1]) : [];

	// Canonicalize prose: drop trailing whitespace introduced by the cut, then
	// add exactly one final newline if there's any content.
	let stripped = lines.slice(0, boundary).join("\n").replace(/\s+$/, "");
	if (stripped !== "") stripped += "\n";

	return {
		matched: true,
		scopeFiles,
		scopeTags,
		strippedBody: stripped,
	};
}
