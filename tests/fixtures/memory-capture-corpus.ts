// tests/fixtures/memory-capture-corpus.ts
// Distilled, anonymized. NOISE must be rejected; KEEPERS must survive the gate.
export const NOISE: { bucket: string; body: string }[] = [
	{ bucket: "pasted-doc", body: "# AGENTS.md instructions for /x\n<INSTRUCTIONS>\n..." },
	{ bucket: "pasted-doc", body: "🧠 ai-14all strategy doc\n\n## Goals\n..." },
	{
		bucket: "harness",
		body: "This session is being continued from a previous conversation that ran out of context.",
	},
	{
		bucket: "harness",
		body: "<task-notification> <task-id>abc</task-id> <tool-use-id>t</tool-use-id>",
	},
	{
		bucket: "findings",
		body: "Check these findings:\n  - High: the port strategy is inconsistent",
	},
	{ bucket: "findings", body: "1. Major: stdio servers would be spawned twice" },
	{
		bucket: "error-log",
		body: "Got this running the recommended one npm error code 127 npm error git dep",
	},
	{
		bucket: "error-log",
		body: "still the same. Uncaught TypeError: x is not a function at y",
	},
	{ bucket: "ui-tweak", body: "too dimmed, should be lighter" },
	{
		bucket: "ui-tweak",
		body: "the clear button should be smaller, probably same sizing with 12px",
	},
	{ bucket: "process-ctrl", body: "Should be good. Let's write plan." },
	{ bucket: "process-ctrl", body: "push to master then." },
	{ bucket: "vague-ack", body: "ok" },
	{
		bucket: "vague-ack",
		body: "B, I don't want fast, I want well-structured code.",
	},
	{
		bucket: "question",
		body: "What should be tested for the session attention feature?",
	},
	{ bucket: "filler", body: "nvm" },
];

export const KEEPERS: string[] = [
	"CLAUDE_SESSION_ID is too specific to claude. We should make it agnostic. Codex can send its session id too.",
	"Don't put call-graph in the prompt as grep use that more efficiently than ai-cortex as it matches exact-file name.",
	"Don't be specific with -review postfix for mcp server name, we might extend to have more tools later.",
	"Default should be scoped to current session, only extend if empty or explicitly asked for whole project.",
	"any ai-* projects under ~/Dev/ should be candidates for the small repos",
	"Don't need to care about migrations. Still under development, no users yet, tolerate stale db state.",
];
