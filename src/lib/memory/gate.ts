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

const RATIONALE =
	/\b(because|since|so that|to avoid|otherwise|too specific|we might (extend|need)|reads better)\b|\bas .{0,30}(more|better|efficiently)\b/i;
const CORRECTION_SHAPE = /^\s*(no,?\s|stop\b|don'?t\b|actually,|instead\b)/i;

export function signalScore(body: string): number {
	let s = 0;
	if (STANDING_DIRECTIVE.test(body)) s += 1;
	if (RATIONALE.test(body)) s += 1;
	if (CORRECTION_SHAPE.test(body)) s += 1;
	return Math.min(3, s);
}
