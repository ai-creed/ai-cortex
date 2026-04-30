export const HISTORY_SCHEMA_VERSION = 2;

export type ToolCallEvidence = { turn: number; name: string; args: string };
export type FilePathEvidence = { turn: number; path: string };
export type UserPromptEvidence = {
	turn: number;
	text: string;
	nextAssistantSnippet?: string; // ≤500 chars, populated by compactor in v2 sessions
};
export type CorrectionEvidence = {
	turn: number;
	text: string;
	nextAssistantSnippet?: string; // ≤500 chars, populated by compactor in v2 sessions
};

export type EvidenceLayer = {
	toolCalls: ToolCallEvidence[];
	filePaths: FilePathEvidence[];
	userPrompts: UserPromptEvidence[];
	corrections: CorrectionEvidence[];
};

export type ChunkMeta = {
	id: number;
	tokenStart: number;
	tokenEnd: number;
	preview: string;
};

export type ChunkText = { id: number; text: string };

export type SessionRecord = {
	version: number;
	id: string;
	startedAt: string;
	endedAt: string | null;
	turnCount: number;
	lastProcessedTurn: number;
	hasSummary: boolean;
	hasRaw: boolean;
	rawDroppedAt: string | null;
	transcriptPath: string;
	summary: string;
	evidence: EvidenceLayer;
	chunks: ChunkMeta[];
};

export type RawTurn = {
	turn: number;
	role: "user" | "assistant" | "system";
	text: string;
	toolUses?: { name: string; input: unknown }[];
	isCompactSummary?: boolean;
};
