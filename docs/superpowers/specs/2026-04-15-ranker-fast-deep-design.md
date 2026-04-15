# Ranker improvement: fast + deep endpoints

**Date:** 2026-04-15
**Project:** ai-cortex
**Status:** Design approved, ready for implementation plan

---

## 1. Context & problem

`suggest_files` (MCP tool exposed by ai-cortex) ranks repo files against a natural-language task. Current ranker lives in `src/lib/suggest-ranker.ts` and scores files purely by bag-of-tokens matching against **file paths only**, ignoring the 27k+ function names already captured in `cache.functions[]`.

Concrete failure, verified against indexed target-repo repo:

```
task: "card creation title editing in My Work right panel"
top-5: all .md files under .agents/skills/. Zero code files.
```

Three root causes:

1. **Tokenizer loses CamelCase.** `CardView.tsx` tokenizes to `[cardview]`, a single token. Task token `card` never matches.
2. **`functions[]` is ignored.** The cache stores every exported/local function, but the ranker never scores against function names.
3. **Doc body dominates.** `title + body + path` are tokenized together, so a long body token list overwhelms the much stronger title signal. Docs beat code files for any query with common English words.

Secondary problems:

- No stopword filter — `in`, `my`, `the` pollute the token set.
- No morphology — `editing` never matches `editor`/`edit`.
- No way to surface class names, exported constants, JSX tags (none of which are in `functions[]`).

## 2. Goals & non-goals

**Goals**

- Code files outrank docs when the task describes code behaviour.
- `suggest_files` stays effectively instant (~10ms) — no I/O, no schema change.
- A deeper endpoint exists for agents when fast fails, with a predictable latency ceiling (~300ms typical, 700ms hard).
- No cache schema bump — all work is query-time against existing v3 cache.
- Backward-compatible MCP and CLI surfaces for existing callers.

**Non-goals**

- Semantic embeddings / LLM-based reranking (out of scope; pins determinism).
- Persistent inverted indexes (deferred to a possible Approach C).
- Additional languages beyond TypeScript/JavaScript (no extractor changes).
- Git-log recency signals (deferred).

## 3. Architecture

Two MCP tools, superset relationship:

```
suggest_files        → fast path (Approach A)         : ~10ms
suggest_files_deep   → superset of fast + extras (B)  : ~300ms typical
```

`suggest_files_deep` always invokes the fast ranker internally and augments the result. The agent never needs to call both; if the fast result is weak, it calls deep, which returns a strict improvement (or equivalent).

Escalation is **agent-driven**, not server-driven. Fast-tool description tells the agent when to escalate. No auto-fallback in code, so latency is honest and predictable.

### Flow

```
suggest_files        → suggestRepo(mode:"fast")
                        └─ rankSuggestions(cache, task, opts)

suggest_files_deep   → suggestRepo(mode:"deep")
                        └─ rankSuggestionsDeep(cache, task, opts, worktreePath)
                            ├─ rankSuggestions(...)        // reuse fast
                            ├─ buildTrigramIndex(...)      // on-demand
                            ├─ trigramQuery(...)           // fuzzy
                            ├─ contentScan(...)            // read top candidates
                            └─ merge + rescore
```

## 4. Module layout

```
src/lib/
├── suggest.ts              (orchestrator — adds mode param)
├── suggest-ranker.ts       (FAST path; refactored to use new tokenizer + functions[])
├── suggest-ranker-deep.ts  (NEW — superset of fast)
├── tokenize.ts             (NEW — shared camelCase/snake tokenizer + stopwords)
├── trigram-index.ts        (NEW — built on-demand per deep query)
└── content-scanner.ts      (NEW — query-time grep over top candidates)
```

Rationale:

- Fast ranker stays **pure, no I/O** — easy to test, fast to reason about.
- Deep ranker does I/O (reading candidate files) — isolated in its own module so fast path stays clean.
- Shared `tokenize.ts` ensures both paths use identical tokenization (no drift between fast and deep).

## 5. Tokenizer (`tokenize.ts`)

### Rules

1. Split on path separators (`/`, `\`) — no cross-segment joining.
2. Within each segment, split on every other non-alphanumeric character (`_`, `-`, `.`, spaces, etc.).
3. Additionally split each raw word on camelCase / PascalCase boundaries: `fooBarBaz` → `foo`, `bar`, `baz`.
4. Handle ALLCAPS boundary correctly: `XMLParser` → `xml`, `parser` (not `x`, `m`, `l`, `parser`).
5. Emit the **joined** lowercased form as an extra token:
   - For any raw word: just its lowercase (`CardView` → `cardview`).
   - For a segment split purely by `_` / `-` separators (snake/kebab): the concatenation of its alnum parts (`my_work_panel` → `myworkpanel`). Segments containing other non-alphanumeric characters (notably `.`, as in `Card.tsx`) do **not** emit a cross-separator join, to avoid polluting tokens with things like `cardtsx`.
6. Lowercase all tokens.
7. Apply stopwords **to task tokens only** (not path tokens).
8. Drop single-char tokens except pure digits.
9. Dedup.

### Stopwords

Kept short and domain-aware. Applied only when tokenizing the **task** string.

```
English noise:  a, an, the, of, in, on, at, to, for, from, by, with, and, or, is, are, be
Task noise:     my, your, our, this, that, new
Code noise:     src, lib, index, utils, helper, helpers, common
```

**Deliberately NOT in STOPWORDS:** task-verb words `create`, `update`, `add`, `fix`, `make`, `use`, `using`. These appear in real code identifiers (`createCard`, `addUser`, `useFetch`, `fixBug`); filtering them from tasks would drop meaningful query tokens and prevent fuzzy matches against those identifiers.

**Example** — task `"card creation title editing in My Work right panel"`:

- Old tokens: `[card, creation, title, editing, in, my, work, right, panel]`
- New tokens: `[card, creation, title, editing, work, right, panel]`

**Example** — path `src/components/MyWork/CardPanel/CardTitleEditor.tsx`:

- Old tokens: `[src, components, mywork, cardpanel, cardtitleeditor, tsx]` — matches zero task tokens.
- New tokens: include `my, work, mywork, card, panel, cardpanel, card, title, editor, cardtitleeditor` — matches `card, title, work, panel`.

## 6. Fast-path ranker (`suggest-ranker.ts`)

### Scoring formula

```
score(file) =
    PATH_TOKEN_SCORE(file, taskTokens)        // per-token match × 5
  + FUNCTION_NAME_SCORE(file, taskTokens)     // NEW, capped at 12
  + DOC_BODY_SCORE(file, taskTokens)          // only for doc files, rebalanced
  + ENTRY_BONUS(file)                          // +2 if in entryFiles
  + ANCHOR_SIGNALS(file, from)                 // unchanged
  + GRAPH_SIGNALS(file, from, cache)           // unchanged
```

### Weights

| Signal | Formula | Notes |
|---|---|---|
| Path tokens | `uniqueMatches × 5` | unchanged |
| Function names | `sum over file's functions of (matches × (exported ? 3 : 1))`, capped at 12 | NEW |
| Doc title | `matches × 8` | NEW weight; titles are strong |
| Doc path | `matches × 5` | same as code path |
| Doc body | `uniqueMatches × 2` (count once, not TF) | prevents body dominance |
| Entry bonus | +2 | unchanged |
| Anchor exact | +6 | unchanged |
| Same directory as anchor | +2 | unchanged |
| Direct import target | +4 | unchanged |
| Direct importer | +4 | unchanged |
| Call-connected to anchor | +3 | unchanged |
| Fan-in > 5 | +1 | unchanged |
| Call-connected to top-ranked (pass 2) | +2 | unchanged |

### Function name scoring — cap rationale

A utility file with 50 functions whose names overlap the task could otherwise dominate a single well-named feature file. Capping the contribution at 12 forces **breadth over depth**: several files with small matches beat one file with many weak matches.

### Reason string format

Compositional, debuggable:

```
"path:card,title,work | fn:CardTitleEditor.handleTitleEdit | entry"
```

Kept short; agent can parse or display as-is.

### Backward compatibility

- Public `rankSuggestions(task, cache, opts)` signature unchanged.
- `SuggestItem.reason` still a string.
- Cache schema unchanged.
- All existing 56 test cases continue to pass (regression guard).

## 7. Deep-path ranker (`suggest-ranker-deep.ts`)

Strict superset. Adds three capabilities on top of the fast result.

### 7.1 Trigram fuzzy match (`trigram-index.ts`)

Standard IR technique (Zoekt, `pg_trgm`, GitHub code search). Handles morphology and typos cheaply, pure JS, no deps.

```ts
export function trigrams(s: string): Set<string>
export function buildTrigramIndex(items: { id: string; tokens: string[] }[]): TrigramIndex
export function trigramQuery(
  idx: TrigramIndex,
  query: string,
  minOverlap?: number,
): Map<string, { sim: number; matchedToken: string }>
```

- `id` = file path
- `tokens` = per-file identifier tokens produced by the shared tokenizer (`splitCamel` applied to the file path and to every function name recorded for that file, deduped). **Not** a single concatenated blob.
- `query` = one task token (caller loops over `tokenizeTask(task)` and unions the results)
- Returns, per item, `{ sim, matchedToken }` — `sim` is the max Jaccard ∈ [0, 1] over the item's tokens and `matchedToken` is the file-side token that produced that max. `DeepSuggestItem.trigramMatches[].matchedToken` stores this (not the file path — review finding v1.4).
- Default `minOverlap = 0.4`

> **Why per-token, not per-blob (review finding v1.3):** Jaccard on a single concatenated `"src/features/mywork/CardTitleEditor.tsx createCard handleTitleEdit"` blob versus the 4-trigram query `"editor"` yields sim ≈ 0.07 — well below any reasonable threshold. Splitting each identifier into its own trigram set and reducing by max restores the intuitive behaviour: `"editor"` vs the token `"editor"` (produced by `splitCamel("CardTitleEditor")`) is sim 1.0, and the many unrelated tokens on the same file don't dilute it. This matches how ctags/fuzzy finders think about identifier matching.

**Cost estimate:** ~7k files × avg ~8 tokens × 4 trigrams/token ≈ 225k trigrams total, pure-JS Set ops. First deep call per repo: ~50–100ms (dominated by index build). Subsequent queries on the same cached index are <20ms.

**Scoring contribution:** `trigramScore = sim × 4` (range 0–4). Capped low — trigrams are a tiebreaker, not primary.

### 7.2 Content scan (`content-scanner.ts`)

Query-time grep over the top ~60 candidates from `fastResults ∪ trigramMatches`.

> **Pool sizing (critical — addresses review finding #2).** The fast ranker today slices to the caller's `limit` at the end (`src/lib/suggest-ranker.ts` final `.slice(0, options.limit ?? 5)`). If the deep path simply called `rankSuggestions(task, cache, {limit: 5})`, content scan would only see 5 fast candidates and could not rescue near-miss files.
>
> **Fix:**
> - Add a `poolSize?: number` option to `rankSuggestions`. When set, the final slice honors `poolSize` **instead of** `limit`.
> - `rankSuggestionsDeep` always calls fast with `poolSize = max(opts.poolSize ?? 60, opts.limit ?? 5)`, **regardless of the user-facing `limit`**.
> - After trigram + content scan + rescore, deep slices to the caller's `limit` at the very end.
>
> This is the single most important implementation detail — call it out in code comments in both ranker files.

> **Pool union rule (addresses review finding v1.3).** The content-scan candidate list is the **union** of:
> - (a) fast-ranker top entries (highest-score first) up to the remaining budget, and
> - (b) trigram-only rescues sorted by their trigram-derived score, capped at `poolSize`.
>
> Total length is **hard-capped at `poolSize`** (review finding v1.4). When trigram rescues would otherwise oversaturate the pool, lower-similarity rescues are dropped first (their score is `sim × TRIGRAM_WEIGHT`, so the ordering is meaningful). Simply slicing `[...byPath.keys()].slice(0, poolSize)` after inserting fast results first would exclude trigram rescues — which is the one thing this stage exists to catch. Fast entries are trimmed to fit the remaining budget after trigram-only selection.

```ts
export function contentScan(
  worktreePath: string,
  filePaths: string[],
  tokens: string[],
): Map<string, ContentHit[]>
```

Catches symbols invisible to `functions[]`:

- Class names: `class CardTitleEditor`
- Exported constants: `export const MY_WORK_PANEL = ...`
- JSX tags: `<RightPanel>`
- String literals that may encode the feature name

**Implementation choices:**

- Synchronous `fs.readFileSync` — pool is small (~60), files are already in OS page cache post-index.
- Line-by-line scan, record up to 3 hits per file with line number + snippet.
- Skip files > 500KB (binary/generated).
- **Budget guard:** abort if pool scan exceeds 400ms → return partial, flag `contentScanTruncated: true` in response.

**Scoring contribution:** `contentScore = min(uniqueTokensFound × 3, 9)`.

### 7.3 Merge & rescore

```
finalScore = fastScore + trigramScore + contentScore
```

Reason strings compose across all signals:

```
"path:card,title | fn:CardTitleEditor | content:RightPanel@L42 | trigram:editor~editing"
```

### 7.4 Deep-only response additions

```ts
type DeepSuggestItem = SuggestItem & {
  contentHits?: { line: number; snippet: string }[]   // up to 3
  trigramMatches?: { taskToken: string; matchedToken: string; sim: number }[]
}
```

Giving the agent concrete evidence (line numbers, snippets) makes the follow-up file read targeted rather than exploratory.

### 7.5 Latency budget

| Stage | Target | Hard ceiling |
|---|---|---|
| Fast ranker (embedded) | <10ms | — |
| Trigram index build | ~100ms | 200ms |
| Trigram query | <20ms | — |
| Content scan (60 files) | ~200ms | 400ms then abort |
| **Total** | **~300ms** | **~700ms** |

Response includes `durationMs` so agents and users can observe actual cost.

### 7.6 Safety

- Content scan only reads files already in `cache.files` (git-tracked).
- Reads through `path.join(worktreePath, ...)` — no traversal escape.
- File-size cap guards against pathological files.

### 7.7 Stale-cache semantics in deep mode (addresses review finding #4)

`stale:true` on the orchestrator means "use the cached index even if the fingerprint is out of date; do not reindex". Fast ranking stays purely in the cache. Deep is mixed because content scan reads **live disk** via `fs.readFileSync`. Three choices considered:

- **(a)** Deep ignores `stale:true` and always reindexes → safe but surprising; breaks caller's explicit contract with the `stale` flag.
- **(b)** Deep disables content scan under `stale:true` → deep becomes "fast + trigram" only; loses the main reason to call deep.
- **(c) Chosen:** Deep permits mixed behaviour — ranking uses cached graph/function data, snippets come from current disk — but surfaces the condition to the caller so the agent can reason about it.

**Rule:**
- When `stale:true` and `mode:"deep"`:
  - Content scan still runs against current disk.
  - Response sets `cacheStatus: "stale"` (as today) and adds `staleMixedEvidence: true` on deep responses.
  - Snippets returned reflect **disk at query time**, not the state represented by the cache. Agent should prefer re-reading the cited file if exact alignment with cached graph matters.
  - Files that exist in `cache.files` but were deleted from disk since cache was built are silently skipped by content scan (already covered by existing safety rule).

The CLI `suggest-deep --stale` prints a one-line warning above the results when `staleMixedEvidence:true`.

## 8. MCP & CLI surfaces

### MCP tools (`src/mcp/server.ts`)

**`suggest_files`** — description updated, schema unchanged:

```
Get a ranked list of files relevant to a task. Fast (~10ms), uses path tokens,
function names, import/call graph. Best when the task mentions names likely to
appear in code (component names, feature names). If results look off (all docs,
or low relevance), call `suggest_files_deep` for fuzzy + content search.
```

**`suggest_files_deep`** — new tool:

```
Deeper file search. Superset of suggest_files: adds trigram fuzzy match
(handles morphology like 'editing' ↔ 'editor') and content scan over top
candidates (finds class names, exported consts, JSX tags not in the function
index). Slower (~300ms typical, 700ms max). Use when `suggest_files` returns
low-relevance results or the task uses natural-language feature descriptions
rather than code names.
```

Schema additions for deep:

- `limit` — default 5, max 20 (fast: default 5, max 20 also — but typical fast use stays at 5)
- `poolSize` — deep-only; candidate pool size, default 60, max 200. **Validated at the orchestrator boundary** (`suggestRepo`): must be an integer in `[1, 200]`. NaN, fractional, out-of-range, and negative values throw `IndexError` before reaching the ranker so invalid CLI input (`--pool foo` → `Number(...)` → `NaN`) cannot silently propagate into `Array.slice()` (review finding v1.3).

### MCP output format (addresses review finding #1)

Current `suggest_files` handler emits only `path` and `reason` text, hiding `score` and `kind`. The design's escalation heuristics reference those fields, so they must be observable to the agent.

**Use the MCP protocol's native structured-output channel, not a JSON-in-content convention.** The SDK (`@modelcontextprotocol/sdk ^1.0.0`) provides two complementary fields on `CallToolResult` (see `node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts:2601` and `server/mcp.d.ts:257`):

- `content: ContentBlock[]` — human-readable content (text, images, …) for MCP clients that render to users/logs.
- `structuredContent?: { … }` — **native** structured return, intended for programmatic consumption. Populated when the tool declares an `outputSchema`.

**Migration from the current `server.tool(...)` call:**

The current handler uses the **deprecated** `server.tool(name, description, inputSchema, cb)` overload, which has no `outputSchema` parameter. Both suggest tools move to the modern `server.registerTool(name, config, cb)` API so they can declare `outputSchema` and return `structuredContent`:

```ts
server.registerTool(
  "suggest_files",
  {
    description: "…",
    inputSchema: { task: z.string().min(1), path: z.string().optional(), /* … */ },
    outputSchema: FastSuggestResultSchema.shape,  // zod shape of FastSuggestResult
  },
  async (args) => {
    const result = await suggestRepo(args.path ?? process.cwd(), args.task, { mode: "fast", /* … */ });
    return {
      content: [{ type: "text", text: renderFastTextOutput(result) }],
      structuredContent: result,  // native structured channel
    };
  },
);
```

Same pattern for `suggest_files_deep` with `DeepSuggestResultSchema`. Zod schemas are derived from the TypeScript types in §9 and co-located near the type definitions so the two cannot drift.

Other tools in the same file (`rehydrate_project`, `index_project`, `blast_radius`) retain the deprecated API for now — migrating them is out of scope for this spec.

**What the agent sees:**

- `result.content[0].text` → human-rendered summary (see text formats below).
- `result.structuredContent` → the full `SuggestResult` object (typed per §9). Agent reads `structuredContent.results[0].score`, `structuredContent.mode`, `structuredContent.staleMixedEvidence`, `structuredContent.results[i].kind`, etc. This is the source of truth for escalation heuristics.

Text content (`content[0].text`), **fast**:

```
suggested files for: <task>
mode: fast · cacheStatus: fresh · durationMs: 4

1. src/features/mywork/CardTitleEditor.tsx  [file · score 24]
   reason: path:card,title,work | fn:CardTitleEditor,handleTitleEdit
2. src/features/mywork/index.ts              [file · score 11]
   reason: path:work | direct-importer-of-anchor
...

escalation hint: top score=24, 5 code files in top-5 — deep unlikely to help
```

Text content, **deep** (adds snippets + evidence markers):

```
suggested files (deep) for: <task>
mode: deep · cacheStatus: fresh · durationMs: 287 · pool: 60

1. src/features/mywork/CardTitleEditor.tsx  [file · score 29]
   reason: path:card,title,work | fn:CardTitleEditor | content:RightPanel@L42 | trigram:editor~editing
   content:
     L42: <RightPanel active={editingId === card.id}>
     L58: function handleTitleEdit(card: Card) {
...
```

**Escalation hint** appears only in the fast text output, as a short single-line suggestion. Purely advisory — does not prevent the agent from deciding otherwise. Kept as:

```
escalation hint: top score=<n>, <k> code files in top-<N>, <reason-if-any>
```

Deep output omits the hint.

### CLI (`src/cli.ts`)

```
ai-cortex suggest       "<task>" [path] [--from <f>] [--limit N] [--stale] [--json]
ai-cortex suggest-deep  "<task>" [path] [--from <f>] [--limit N] [--stale] [--json] [--pool N]
```

Human output for `suggest-deep` inlines content-hit snippets (same text layout as MCP text part above). `--json` emits the full `SuggestResult` for scripting.

## 9. Response shape (addresses review finding #3)

Result type is a **discriminated union on `mode`**. This gives typed callers a stable contract and prevents fast callers from accidentally consuming deep-only evidence fields.

```ts
// Base item — returned by fast mode.
export type SuggestItem = {
  path: string;
  kind: "file" | "doc";
  score: number;
  reason: string;
};

// Deep item — strict superset of SuggestItem.
export type DeepSuggestItem = SuggestItem & {
  contentHits?: { line: number; snippet: string }[];     // up to 3 per file
  trigramMatches?: { taskToken: string; matchedToken: string; sim: number }[];
};

type SuggestResultCommon = {
  cacheStatus: "fresh" | "reindexed" | "stale";
  durationMs: number;
  task: string;
  from: string | null;
};

export type FastSuggestResult = SuggestResultCommon & {
  mode: "fast";
  results: SuggestItem[];
};

export type DeepSuggestResult = SuggestResultCommon & {
  mode: "deep";
  results: DeepSuggestItem[];
  poolSize: number;                    // actual pool used
  contentScanTruncated?: boolean;      // set when 400ms content-scan ceiling hit
  staleMixedEvidence?: boolean;        // set when stale:true produced mixed cache+disk evidence (see §7.7)
};

export type SuggestResult = FastSuggestResult | DeepSuggestResult;
```

Consumers narrow on `mode`:

```ts
if (result.mode === "deep") {
  // safe to read result.results[n].contentHits etc.
}
```

Existing library exports in `src/lib/suggest.ts` (`SuggestItem`, `SuggestResult`) are updated to match. `SuggestOptions` gains `mode?: "fast" | "deep"` (default `"fast"`) and `poolSize?: number`.

### Agent escalation heuristics (encoded in tool description + readable from structured output)

The agent reads the structured JSON content part (see §8) to apply these rules:

- `results[0].score < 10` → try deep.
- No item with `kind === "file"` in top-N → try deep.
- Task contains natural-language verbs (`editing`, `handling`, …) rather than exact identifiers → try deep.
- User explicitly asks to search deeply → use deep.

No server-side auto-escalation. The fast text output includes a one-line `escalation hint` as a hint, but the machine-readable fields are the source of truth for agent decisions.

## 10. Testing strategy

TDD — write failing tests first, then implement.

### Files

```
tests/unit/lib/
├── tokenize.test.ts                (NEW)
├── suggest-ranker.test.ts          (extend existing 56 cases)
├── suggest-ranker-deep.test.ts     (NEW)
├── trigram-index.test.ts           (NEW)
└── content-scanner.test.ts         (NEW)

tests/integration/
└── suggest-deep.test.ts            (NEW — small fake repo, real I/O)
```

### Key cases

**`tokenize.test.ts`:**

| Input | Expected |
|---|---|
| `CardView` | `[card, view, cardview]` |
| `MyWorkPanel` | `[my, work, panel, myworkpanel]` |
| `XMLParser` | `[xml, parser, xmlparser]` |
| `my_work_panel` | `[my, work, panel, myworkpanel]` |
| `src/features/MyWork/Card.tsx` | includes `my, work, card, features` |
| `v2Api` | `[v2, api, v2api]` |
| `a.b.c` | `[]` |
| task=`card in my work panel` | `[card, work, panel]` |
| path=`src/my/work.ts` | keeps `my, work` (no stopword filter) |
| `CardCard` | `[card, cardcard]` |

**`suggest-ranker.test.ts`** — extend existing:

- Original failing query against synthetic cache → code files top the list.
- **`poolSize` option:** when set, fast ranker returns up to `poolSize` results instead of `limit`. Regression guard for review finding #2.
- Exported function match beats unexported function match.
- Function score cap at 12 respected.
- Title match beats body match.
- Stopwords suppress only task-side, not path-side.

**`trigram-index.test.ts`:**

- `editing` vs `editor` → sim ≈ 2/7 (0.286) — below default minOverlap (0.4); documents actual Jaccard value.
- `card` vs `carding` → sim = 0.4 (exactly at default minOverlap).
- `edit` vs `editor` → sim = 0.5 (clearly above threshold; substring-style morphology matches reliably).
- `foo` vs `bar` → sim = 0.
- Empty input doesn't crash.
- Non-ASCII doesn't crash.

> **Jaccard threshold reality check (v1.6):** Pure Jaccard-on-trigrams is not generous with derivational morphology — `editing`/`editor` shares only 2 of 7 trigrams (`edi`, `dit`), yielding 0.286. That's intentionally below the default 0.4 `minOverlap` because we prefer precision over recall in the rescue path; we don't want the trigram-only pool saturated by every distant morphological cousin. The cases that DO cross the threshold in practice are substring-style matches (`edit`↔`editor` = 0.5), extension/shortening by one syllable (`card`↔`carding` = 0.4), and exact matches (`editor`↔`editor` = 1.0). The deep ranker's content scan (§7.2) handles the morphology cases that trigrams miss.

**`content-scanner.test.ts`:**

- `class CardEditor` → hit recorded.
- `<RightPanel>` → hit recorded.
- `export const MY_WORK_PANEL` → hit recorded.
- File > 500KB → skipped.
- Missing file → skipped, no throw.
- Hits per file capped at 3.
- Injected slow reader → returns partial + `truncated:true`.

**`suggest-ranker-deep.test.ts`** — with mocked content scanner:

- Deep result ⊇ fast top-N (unless displaced by higher-scoring deep-only hit).
- **Pool-vs-limit (review finding #2):** with `limit:5` and `poolSize:60`, a file ranked #30 by fast but with strong content evidence reaches the final top-5. Regression guard.
- Trigram-only match surfaces when sim high.
- Content-only match surfaces with evidence.
- Discriminated-union typing: `result.mode === "deep"` narrows `result.results` to `DeepSuggestItem[]` (compile-time TypeScript test).
- `durationMs` reported.
- `contentScanTruncated` propagates.
- **Stale+deep (review finding #4):** when `stale:true`, `staleMixedEvidence:true` is set on the response; content scan still runs; deleted-on-disk files from the cache are silently skipped.

**`tests/integration/suggest-deep.test.ts`:**

Small synthetic repo under `tests/fixtures/deep-repo/` with a real `git init`. Runs `suggestRepo(..., {mode:"deep"})` and asserts:

- `CardTitleEditor.tsx`-style file is #1 for the failing task.
- Content snippet contains `RightPanel`.
- `durationMs` < 1000ms on the tiny corpus.

**MCP handler tests** (new, `tests/unit/mcp/server.test.ts` — extend if present, else create):

- Both tools are registered via `server.registerTool(...)` with an `outputSchema` (review finding #1 / v1.2).
- Both tools' responses carry a native `structuredContent` field whose shape satisfies the declared `outputSchema` (validate with the zod schema in tests).
- `structuredContent.mode` matches the tool (`"fast"` for `suggest_files`, `"deep"` for `suggest_files_deep`).
- `structuredContent.results[0]` has `score` and `kind`.
- `content[0].text` is human-readable and includes `score` + `kind` inline per item.
- Fast `content[0].text` includes the `escalation hint` line; deep does not.
- Deep `content[0].text` includes content snippets when any hits exist.
- Round-trip: parsing `structuredContent` back through the zod schema yields a deep-equal object to the ranker's internal `SuggestResult`.

### Golden test

A pinned test with a synthetic cache mimicking target-repo's structure. Fast path must return ≥1 code file in top-5; deep path must return the simulated `CardTitleEditor.tsx` at #1. Regression guard for the originating failure.

### Coverage target

80%+ on new modules, per standing preference.

### Out of scope

- Latency benchmarks on target-repo-sized repos — belongs in a manual script, not CI.
- Non-TypeScript adapters.

## 11. Open questions / future work

- **Approach C (persistent inverted index)** — revisit if deep path is too slow on larger repos than target-repo.
- **Git recency boost** — files touched in the last N commits scored higher. Out of scope now.
- **LSP integration** — could extract richer symbol info (types, interfaces). Out of scope.
- **Non-TS languages** — adapter pattern exists (`adapters/typescript.ts`); add more when needed.

## 12. Implementation order

Suggested sequence (to be refined by writing-plans step):

1. `tokenize.ts` + tests — unblocks everything else.
2. Refactor fast ranker to use new tokenizer + `functions[]` + rebalanced doc scoring, **and add `poolSize` option** (review finding #2). Verify all existing tests still pass and original failing query now surfaces code files.
3. `trigram-index.ts` + tests.
4. `content-scanner.ts` + tests.
5. `suggest-ranker-deep.ts` + tests — must call fast with `poolSize ≥ 60`; set `staleMixedEvidence` when applicable (review finding #4).
6. Update `src/lib/suggest.ts` types to the discriminated union in §9 (review finding #3); wire `mode` through.
7. Migrate both suggest MCP tools from the deprecated `server.tool(...)` to `server.registerTool(...)` with `outputSchema`. Return `content` (text with `score`/`kind`/escalation hint for fast, snippets for deep) and native `structuredContent` carrying the full `SuggestResult` (review findings #1 and v1.2). Define zod schemas `FastSuggestResultSchema` / `DeepSuggestResultSchema` co-located with the TS types from §9. Add `suggest-deep` CLI subcommand.
8. Integration test on synthetic repo; MCP handler tests.
9. Manual benchmark on target-repo; confirm latency budgets.

## 13. Changelog

- **2026-04-15 v1** — initial design, approved section-by-section during brainstorming.
- **2026-04-15 v1.1** — applied 4 review findings:
  - §7.2 added **pool-sizing rule** — deep calls fast with `poolSize ≥ 60`, slices to `limit` only at the very end.
  - §7.7 new — **stale+deep semantics** documented; adds `staleMixedEvidence` flag.
  - §8 rewritten — MCP surfaces `score`/`kind`/escalation state to the agent; text output now includes `score` and `kind`; fast output carries a one-line `escalation hint`.
  - §9 rewritten — `SuggestResult` is now a **discriminated union on `mode`**, giving typed callers `FastSuggestResult` / `DeepSuggestResult`.
  - §10 extended — regression-guard cases added for pool vs limit, stale+deep, and MCP structured output.
- **2026-04-15 v1.2** — protocol-correctness fix (one additional review finding):
  - §8 corrected — structured data now returned via the MCP SDK's **native `structuredContent` field**, not a second JSON content block. Both suggest tools migrate from the deprecated `server.tool(...)` to `server.registerTool(...)` so they can declare `outputSchema`. Zod schemas `FastSuggestResultSchema` / `DeepSuggestResultSchema` derive from the types in §9.
  - §10 MCP handler tests rewritten to assert on `structuredContent` + `outputSchema` conformance rather than a second content block.
  - §12 step 7 updated to explicitly cover the SDK migration.
- **2026-04-15 v1.3** — plan-review pass, four findings:
  - §7.1 reworked — trigram index is now **per identifier token**, not per concatenated blob. `buildTrigramIndex` takes `{id, tokens[]}`; `trigramQuery` returns max-Jaccard over the item's tokens. Fixes collapse-to-zero similarity on realistic repos (e.g. "editor" vs a file whose concatenated text was ~30 trigrams scored at 0.07).
  - §7.2 added **pool-union rule** — content-scan candidate list is `(top fast entries by score) ∪ (all trigram-only rescues)`, capped at `poolSize`. Guards against the bug where `.slice(0, poolSize)` after inserting fast results first silently dropped every trigram-only path.
  - §8 `poolSize` now **validated at `suggestRepo`** (integer in `[1, 200]`, rejects `NaN`); CLI `--pool` hardened to reject non-finite numeric inputs at the argv boundary.
  - Implementation plan (`docs/superpowers/plans/2026-04-15-ranker-fast-deep.md`) Task 7 tests aligned with the `ContentScanResult` return shape (tests now use `res.hits.get` / `res.hits.size`, not `res.get` / `res.size`).
- **2026-04-15 v1.4** — second plan-review pass, five findings:
  - §7.1 — `trigramQuery` return type now `Map<id, { sim, matchedToken }>`. `DeepSuggestItem.trigramMatches[].matchedToken` stores the actual file-side token that achieved the max Jaccard, not the file path. The plan's prior wiring (which put the path in `matchedToken`) was misleading and is fixed.
  - §7.2 — hard cap on candidate-pool length: trigram-only rescues are sorted by their `sim × TRIGRAM_WEIGHT` score and trimmed to `poolSize`, so `buildCandidatePool` output length is strictly `≤ poolSize` even on pathological queries that trigger many fuzzy rescues.
  - Plan Task 10 — explicit update to the **existing** `tests/unit/mcp/server.test.ts` mocks and `toHaveBeenCalledWith` assertions for the new `mode`/`durationMs` shape (previously the plan only added new tests and would have left the old ones broken).
  - Plan Task 9 — pool-union regression test rewritten to use a genuinely trigram-only rescue (`src/misc.ts` with fn `editorBootstrap`, query `"foo edit"`) instead of `src/CardTitleEditor.tsx`, whose path now tokenizes to include the exact query token `editor` and wouldn't actually exercise the rescue path.
  - Plan Task 8 — commit step now stages `tests/unit/lib/suggest.test.ts` along with the source files.
- **2026-04-15 v1.5** — Task 1 implementer escalation, two tokenizer inconsistencies resolved:
  - §5 Rules — split semantics made explicit as **two-tier**: path separators (`/`, `\`) split into segments with no cross-segment join; within a segment, non-alphanumeric chars split into raw words; a snake/kebab-only segment additionally emits the concatenated form (`my_work_panel` → `myworkpanel`); segments containing `.` or other non-`_`/`-` separators do not emit a cross-separator join (so `Card.tsx` stays `card`, `tsx` without `cardtsx`). Previous phrasing "Split on non-alphanumeric" was ambiguous and the spec's reference impl never actually produced `myworkpanel` even though the regression table required it.
  - §5 STOPWORDS — removed task-verb words `create`, `update`, `add`, `fix`, `make`, `use`, `using`. These collide with common code identifiers (`createCard`, `addUser`, `useFetch`, `fixBug`) and the spec test table already required `tokenizeTask("createCard")` to surface `"create"`. Previous STOPWORDS + test were mutually exclusive.
  - Plan Task 1 — implementation snippet and STOPWORDS list updated to match.
- **2026-04-15 v1.6** — Task 6 implementer escalation, Jaccard threshold math corrected:
  - §10 trigram-index test expectations aligned with actual Jaccard values. Previous spec claimed `editing`/`editor` sim `> 0.4` and `card`/`carding` sim `> 0.4`; both are wrong. Correct values: 2/7 ≈ 0.286 and 0.400 exactly. The plan Task 6 test file was updated to use `toBeCloseTo` with the real values. Added an `edit`/`editor` case (0.5) to demonstrate a pair that reliably clears the default 0.4 threshold. Clarifying note added explaining that pure Jaccard trigrams are intentionally precision-biased and the content scan covers morphology cases trigrams miss.
