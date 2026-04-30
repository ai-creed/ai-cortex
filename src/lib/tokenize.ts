// src/lib/tokenize.ts
//
// Shared tokenizer used by both fast and deep rankers. Splits on path
// separators, then within each segment on any non-alphanumeric character,
// then on camelCase / PascalCase / ALLCAPS boundaries. Always emits the
// original lowercased joined form so exact-string matches (e.g. "cardview")
// still score; also emits a snake/kebab joined form within a segment so
// "my_work_panel" matches "myworkpanel".

export const STOPWORDS: Set<string> = new Set([
	// English noise
	"a",
	"an",
	"the",
	"of",
	"in",
	"on",
	"at",
	"to",
	"for",
	"from",
	"by",
	"with",
	"and",
	"or",
	"is",
	"are",
	"be",
	// Task noise (task-verb words like "create", "update", "add", "fix",
	// "make", "use", "using" intentionally NOT included — they appear in
	// real identifiers: createCard, addUser, useFetch, fixBug).
	// "my" is intentionally NOT a stopword: it is load-bearing in domain
	// names (e.g. a feature called "My Work") and would mask such matches.
	"your",
	"our",
	"this",
	"that",
	"new",
	// Code noise
	"src",
	"lib",
	"index",
	"utils",
	"helper",
	"helpers",
	"common",
]);

// Two-tier separator model:
//   PATH_SEPARATOR_RE — never joined across (no "srcfeaturesmywork" tokens).
//   SUBWORD_SEPARATOR_RE — snake/kebab within a path segment; eligible for joining.
//   NON_WORD_RE — fallback split for any other non-alphanumeric (`.`, space, etc.).
// A snake-joined form ("my_work_panel" -> "myworkpanel") is emitted only when
// the whole segment is alnum-plus-underscore-or-dash (so "Card.tsx" does NOT
// emit "cardtsx").
const PATH_SEPARATOR_RE = /[/\\]+/;
const SUBWORD_SEPARATOR_RE = /[_-]+/;
const NON_WORD_RE = /[^a-zA-Z0-9]+/;
const ALNUM_RE = /^[a-zA-Z0-9]+$/;

/**
 * Splits a single word on camelCase / PascalCase / ALLCAPS boundaries.
 * "XMLParser" -> ["XML", "Parser"]
 * "fooBarBaz" -> ["foo", "Bar", "Baz"]
 */
function splitCamel(word: string): string[] {
	if (!word) return [];
	// Two passes: insert a space at any ACap->ACap+lower boundary (XMLParser -> XML Parser),
	// then at any lower->Upper boundary (fooBar -> foo Bar), then split on space.
	const withBoundaries = word
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
	return withBoundaries.split(" ").filter(Boolean);
}

function shouldKeep(tok: string): boolean {
	if (!tok) return false;
	if (tok.length === 1 && /[a-z]/.test(tok)) return false; // drop single alpha chars
	return true;
}

/**
 * Simple English plural stemmer. Returns the singular form for common plural
 * patterns, or null when the word should not be stemmed. Conservative by
 * design — only emits a stem for patterns with low collision risk.
 *   flies  -> fly     (-ies ending, swap to -y)
 *   boxes  -> box     (-xes/-ches/-shes/-sses/-zes: strip 'es')
 *   cards  -> card    (plain -s ending)
 * Non-plural endings left untouched: ss (address), us (status), is (this),
 * os (memos), as (gas), short words (<=3 chars).
 */
function pluralStem(word: string): string | null {
	if (word.length <= 3) return null;
	if (/(ss|us|is|os|as)$/u.test(word)) return null;
	if (/ies$/u.test(word) && word.length > 4) {
		return word.slice(0, -3) + "y";
	}
	if (/(xes|ches|shes|sses|zes)$/u.test(word) && word.length > 4) {
		return word.slice(0, -2);
	}
	if (/s$/u.test(word)) {
		return word.slice(0, -1);
	}
	return null;
}

function addToken(out: Set<string>, tok: string): void {
	if (!shouldKeep(tok)) return;
	out.add(tok);
	const stem = pluralStem(tok);
	if (stem && stem !== tok && shouldKeep(stem)) out.add(stem);
}

function tokensFor(value: string): string[] {
	const out = new Set<string>();
	for (const segment of value.split(PATH_SEPARATOR_RE)) {
		if (!segment) continue;
		// Snake/kebab joined form — only when the whole segment is alnum + [_-].
		const snakeParts = segment.split(SUBWORD_SEPARATOR_RE).filter(Boolean);
		if (snakeParts.length > 1 && snakeParts.every((p) => ALNUM_RE.test(p))) {
			addToken(out, snakeParts.join("").toLowerCase());
		}
		// Tokenize every raw word (splitting on ANY non-alphanumeric within the segment).
		for (const rawWord of segment.split(NON_WORD_RE)) {
			if (!rawWord) continue;
			addToken(out, rawWord.toLowerCase());
			for (const part of splitCamel(rawWord)) {
				addToken(out, part.toLowerCase());
			}
		}
	}
	return [...out];
}

/**
 * Path / identifier tokenizer. Does NOT apply stopword filter — paths should
 * keep words like "my", "work" because they may be domain-meaningful.
 */
export function tokenize(value: string): string[] {
	return tokensFor(value);
}

/**
 * Task-string tokenizer. Applies stopword filter to remove English noise
 * and common code-noise words that would otherwise match many files.
 */
export function tokenizeTask(value: string): string[] {
	return tokensFor(value).filter((tok) => !STOPWORDS.has(tok));
}
