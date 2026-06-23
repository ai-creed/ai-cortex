// src/lib/library/doc-chunker.ts
import type { ChunkOut } from "./types.js";

// gte-small accepts ~512 tokens; ~1800 chars is a safe section ceiling so a
// passage is never silently truncated by the embedder.
export const DEFAULT_MAX_CHARS = 1800;
const DEFAULT_OVERLAP_CHARS = 200;

interface Section {
	headingPath: string[];
	startLine: number; // 1-based, first content line of the section
	lines: { text: string; line: number }[];
}

function parseSections(text: string): Section[] {
	const rawLines = text.split(/\r?\n/);
	const sections: Section[] = [];
	const stack: { level: number; title: string }[] = [];
	let current: Section = { headingPath: [], startLine: 1, lines: [] };

	const flush = () => {
		if (current.lines.length > 0) sections.push(current);
	};

	for (let i = 0; i < rawLines.length; i++) {
		const lineNo = i + 1;
		const line = rawLines[i]!;
		const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
		if (m) {
			flush();
			const level = m[1]!.length;
			const title = m[2]!;
			while (stack.length > 0 && stack[stack.length - 1]!.level >= level)
				stack.pop();
			stack.push({ level, title });
			current = {
				headingPath: stack.map((s) => s.title),
				startLine: lineNo,
				lines: [{ text: line, line: lineNo }],
			};
		} else {
			current.lines.push({ text: line, line: lineNo });
		}
	}
	flush();
	return sections;
}

// Split a section's lines into <= maxChars windows, carrying line spans and a
// char-level overlap tail for retrieval continuity.
function windowSection(
	section: Section,
	ordinalStart: number,
	maxChars: number,
	overlapChars: number,
): ChunkOut[] {
	const fullText = section.lines.map((l) => l.text).join("\n");
	if (fullText.length <= maxChars) {
		return [
			{
				ordinal: ordinalStart,
				headingPath: section.headingPath,
				text: fullText,
				lineStart: section.lines[0]!.line,
				lineEnd: section.lines[section.lines.length - 1]!.line,
			},
		];
	}
	const out: ChunkOut[] = [];
	let buf: { text: string; line: number }[] = [];
	let bufLen = 0;
	let ordinal = ordinalStart;
	const emit = () => {
		if (buf.length === 0) return;
		out.push({
			ordinal: ordinal++,
			headingPath: section.headingPath,
			text: buf.map((l) => l.text).join("\n"),
			lineStart: buf[0]!.line,
			lineEnd: buf[buf.length - 1]!.line,
		});
	};
	for (const l of section.lines) {
		if (bufLen + l.text.length + 1 > maxChars && buf.length > 0) {
			emit();
			// carry an overlap tail (whole lines) into the next window
			const tail: { text: string; line: number }[] = [];
			let tailLen = 0;
			for (let k = buf.length - 1; k >= 0 && tailLen < overlapChars; k--) {
				tail.unshift(buf[k]!);
				tailLen += buf[k]!.text.length + 1;
			}
			buf = tail;
			bufLen = tailLen;
		}
		buf.push(l);
		bufLen += l.text.length + 1;
	}
	emit();
	return out;
}

export function chunkDoc(
	text: string,
	opts: { maxChars?: number; overlapChars?: number } = {},
): ChunkOut[] {
	const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
	const overlapChars = opts.overlapChars ?? DEFAULT_OVERLAP_CHARS;
	const sections = parseSections(text);
	const chunks: ChunkOut[] = [];
	for (const section of sections) {
		for (const c of windowSection(
			section,
			chunks.length,
			maxChars,
			overlapChars,
		)) {
			chunks.push({ ...c, ordinal: chunks.length });
		}
	}
	return chunks;
}
