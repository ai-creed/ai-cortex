// src/lib/memory/gate.ts
// Structural noise-killer. Reject-only — never positively classifies.
// structuralReject(body) → a reason string if the turn is structural noise,
// else null (meaning: survive; the AGENT judges durability later).

const STANDING_DIRECTIVE =
	/\b(always|never|by default|from now on|going forward|in general|whenever|every time|as a rule|prefer .{0,40} over)\b/i;

const RULES: { name: string; test: (b: string) => boolean }[] = [
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
			/Uncaught .*Error|TypeError|ENOENT|EISDIR|exited with code|npm error|API Error:\s*\d|-32601|UserWarning|build failed/i.test(
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
