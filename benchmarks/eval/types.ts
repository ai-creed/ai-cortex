// benchmarks/eval/types.ts

export type StructuralCheck = {
	file: string;
	pattern: string;
	shouldMatch: boolean;
};

export type EvalTask = {
	name: string;
	repo: string;
	repoPath: string;
	prompt: string;
	groundTruthFiles: string[];
	structuralChecks: StructuralCheck[];
	verifyCommand: string;
	needsBuild: boolean;
	timeoutMs: number;
};

export type RunResult = {
	task: string;
	condition: "with" | "without";
	rep: number;
	explorationCalls: number;
	totalToolCalls: number;
	wallClockMs: number;
	filesCorrect: number;
	structuralPass: boolean;
	verifyPass: boolean;
	agentExitCode: number;
};

export type EvalReport = {
	timestamp: string;
	results: RunResult[];
};
