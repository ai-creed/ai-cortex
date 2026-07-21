// src/lib/memory/gate.ts
// Structural noise-killer. Reject-only — never positively classifies.
// structuralReject(body) → a reason string if the turn is structural noise,
// else null (meaning: survive; the AGENT judges durability later).

const STANDING_DIRECTIVE =
	/\b(always|never|by default|from now on|going forward|in general|whenever|every time|as a rule|prefer .{0,40} over)\b/i;

const RULES: { name: string; test: (b: string) => boolean }[] = [
	{
		name: "interrupt-marker",
		test: (b) => /^\s*\[Request interrupted by user( for tool use)?\]/.test(b),
	},
	{
		// Duo-persona/session-roleplay assignments (SANCHO PANZA / IGOR class).
		// Reject BEFORE tier concerns: these often contain "always"/"never" and
		// would otherwise score as high-signal standing directives (spec §4.2).
		name: "duo-roleplay",
		test: (b) =>
			/\[ai-whisper duo\]/i.test(b) ||
			(/\b(you (are|play)|you'?re playing|act(ing)? as|play(ing)?)\b/i.test(b) &&
				/\b(character|persona|duo|roleplay|in character)\b/i.test(b)),
	},
	{
		name: "resume-kickoff",
		test: (b) =>
			b.trim().length < 200 &&
			/^\s*(continue from where|let'?s? resume|resume (with|from) (the )?(current|previous|last)|recap me|the workflow halted)/i.test(
				b,
			) &&
			!STANDING_DIRECTIVE.test(b),
	},
	{
		name: "screenshot-path",
		test: (b) => {
			const m = /\S*[/\\][Ss]creenshot[^\n]*?\.(?:png|jpe?g)\b/.exec(b);
			return m != null && m[0].length > b.trim().length * 0.5;
		},
	},
	{
		name: "structured-blob",
		test: (b) => {
			const t = b.trim();
			// Branch 1: strict JSON blob.
			if (/^[{[]/.test(t)) {
				try {
					JSON.parse(t);
					return true;
				} catch {
					// not strict JSON — fall through to the dominance check
				}
			}
			// Branch 2 (independent of JSON punctuation): body dominated by
			// key:value / log-dump lines (env blobs, version contexts, logs).
			const lines = t.split("\n").filter((l) => l.trim().length > 0);
			if (lines.length < 3) return false;
			const structured = lines.filter((l) =>
				/^\s*"?[\w.@/-]+"?\s*[:=]\s*\S|^\s*\d{4}-\d{2}-\d{2}[T ]|\b(INFO|WARN|ERROR|DEBUG)\b/.test(
					l,
				),
			).length;
			return structured / lines.length > 0.6;
		},
	},
	{
		name: "pasted-doc",
		test: (b) =>
			/^\s*(#|<INSTRUCTIONS>|🧠)/.test(b) ||
			/^\s*#?\s*AGENTS\.md\b/i.test(b),
	},
	{
		name: "harness-pseudo-prompt",
		test: (b) =>
			/This session is being continued from a previous conversation/i.test(
				b,
			) ||
			/<task-notification>|<tool-use-id>|<image name=/i.test(b) ||
			(/\[Image #\d+\]/.test(b) &&
				b.replace(/\[Image #\d+\]/g, "").trim().length < b.length * 0.5),
	},
	{
		// Machine-generated relay prompts from agent-orchestration workflows
		// (ai-whisper et al.) — boilerplate, never a human-stated rule.
		name: "workflow-handoff",
		test: (b) =>
			/\bThis is an autonomous workflow\b|\bno human will respond\b/i.test(b),
	},
	{
		name: "findings-dump",
		test: (b) =>
			/^\s*(?:[-*]\s*)?(\d+\.\s*)?(High|Medium|Critical|Major|Low|P[12]):/im.test(
				b,
			) ||
			/\b(check|more|some|one (more|last))\b.{0,20}\b(findings|finding|pass)\b/i.test(
				b,
			),
	},
	{
		name: "error-log",
		test: (b) =>
			// `{0,200}?` bounds the newline-crossing match so huge bodies stay cheap.
			/Uncaught [\s\S]{0,200}?(Error|Exception)|TypeError|ENOENT|EISDIR|exited with code|npm error|API Error:\s*\d|-32601|UserWarning|build failed/i.test(
				b,
			) ||
			/^\s*(got (some )?error|still the same|saw this error|got this running|how about this error)/i.test(
				b,
			),
	},
	{
		name: "ui-micro-tweak",
		test: (b) =>
			/\b(too dimmed|smaller|bigger|too big|lighter|bolder|gradient|\d+px|margin|flex column|align|highligh|looks (bad|ugly)|broken layout|titlebar|fps|unreadable|line break|capitalized)\b/i.test(
				b,
			) && !STANDING_DIRECTIVE.test(b),
	},
	{
		name: "process-control-or-vague-ack",
		test: (b) => {
			const first = b
				.trim()
				.split(/\s+/)[0]
				?.toLowerCase()
				.replace(/[.,]$/, "");
			if (
				[
					"ok",
					"okay",
					"good",
					"alright",
					"yes",
					"no",
					"fine",
					"b",
					"a",
				].includes(first ?? "") ||
				/^\d+$/.test(first ?? "")
			)
				return true;
			return /\blet'?s? (write|brainstorm)\b|\bwrite plan\b|\bpush to master\b|\bjust merge\b|\bcontinue with the rest\b|\bgo ahead with phase\b|\bsync plan\b|\bwrite this down\b|\bkill your shell\b|\bmonitor and fix\b|\bsmoke test\b/i.test(
				b,
			);
		},
	},
	{
		name: "question",
		test: (b) => b.slice(0, 200).includes("?") && !STANDING_DIRECTIVE.test(b),
	},
	{ name: "filler", test: (b) => b.trim().length < 25 },
];

export function structuralReject(body: string): string | null {
	for (const r of RULES) if (r.test(body)) return r.name;
	return null;
}

// The trailing alternations (from `\bi own\b` onward) are durable-signal
// marker classes, each a generalizable shape a considered decision carries but
// intake chatter does not:
//   - `i own` — an ownership/authority statement fixing a lasting constraint.
//   - `we don't X, we Y` — the contrastive-decision idiom (rejecting A for B).
//   - `not a good idea` / `doesn't make sense` / `doesn't fit` — an evaluative
//     judgment (a considered rejection of an option or direction).
//   - `is a … workflow|pattern|system|…` — a definitional statement (naming a
//     concept), inherently durable knowledge.
//   - `philosophy|principle|north star|vision` — explicit guiding-direction
//     nouns; a stated principle is durable by construction.
//   - `i'm more with` — a preference, alongside the existing `i like/prefer`.
//   - leading `if i remember|recall` — recall of an established fact/procedure.
//   - `the only way` — a necessity/justification idiom ("that's the only way to
//     prove X"): asserting a path is the sole viable one is durable rationale.
const RATIONALE =
	/\b(because|since|so that|to avoid|otherwise|too specific|we might (extend|need)|reads better)\b|\bas .{0,30}(more|better|efficiently)\b|\bshould(n'?t| not)? (be|not|fix|own|live|stay|go)\b|\bmust(n'?t| not)? \w|\bneeds? to be\b|\bdoesn'?t need to\b|\bdon'?t (want|need)\b|\bi (don'?t )?(like|prefer|want)\b|\bwhy we (need|use|chose|keep)\b|\bmeaning that\b|^\s*(diagnosis|root cause|conclusion)\s*:|^\s*[\w'-]+(\s[\w'-]+){0,3}\s*=\s+\S|\bi own\b|\bwe don'?t \w+, we\b|\b(not a good idea|doesn'?t make sense|doesn'?t fit)\b|\bis an? [\w-]+ (workflow|pattern|system|approach|product|convention)\b|\b(philosophy|principle|north star|vision)\b|\bi'?m more with\b|^\s*if i (remember|recall)\b|\bthe only way\b/im;
// Leading redirection/correction openers. "actually" and "wait" begin a
// course-correction the same way "no,"/"instead" do; broadened from the
// comma-only "actually," so "Actually I already solved …" also counts.
const CORRECTION_SHAPE =
	/^\s*(no,?\s|stop\b|don'?t\b|actually\b|instead\b|wait[,\s])/i;

export function signalScore(body: string): number {
	let s = 0;
	if (STANDING_DIRECTIVE.test(body)) s += 1;
	if (RATIONALE.test(body)) s += 1;
	if (CORRECTION_SHAPE.test(body)) s += 1;
	return Math.min(3, s);
}

export type CaptureTierValue = "high" | "low";

// Derived, never persisted: tier is recomputed from the body wherever needed
// (pending-captures view, briefing digest, aging sweep) so scoring
// improvements re-tier the whole store retroactively with no migration.
export function captureTier(body: string): CaptureTierValue {
	return signalScore(body) >= 1 ? "high" : "low";
}
