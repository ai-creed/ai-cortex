// benchmarks/lib/types.ts

export type SizeBucket = "small" | "medium" | "large";

export type RepoConfig = {
	name: string;
	path: string;
	required: boolean;
	sizeBucket: SizeBucket;
};

export type ScenarioName =
	| "index:cold"
	| "rehydrate:warm"
	| "rehydrate:stale"
	| "suggest:warm"
	| "blastRadius:warm";

export type TimingResult = {
	p50: number;
	p95: number;
	min: number;
	max: number;
	runs: number;
};

export type RegressionStatus = "pass" | "warn" | "fail" | "skip";

export type ScenarioResult = {
	repo: string;
	scenario: ScenarioName;
	timing: TimingResult;
	slo: number | null;
	baseline: number | null;
	regressionPct: number | null;
	status: RegressionStatus;
};

export type QualityStatus = "pass" | "fail";

export type SuggestQualityResult = {
	suite: "golden-set";
	name: string;
	precision: number;
	recall: number;
	status: QualityStatus;
};

export type BlastRadiusQualityResult = {
	suite: "golden-set";
	name: string;
	hitsFound: number;
	hitsExpected: number;
	confidence: "full" | "partial";
	minConfidence: "full" | "partial";
	status: QualityStatus;
};

export type RankingQualityResult = {
	suite: "ranking";
	name: string;
	pairsPass: number;
	pairsTotal: number;
	status: QualityStatus;
};

export type QualityResult =
	| SuggestQualityResult
	| BlastRadiusQualityResult
	| RankingQualityResult;

export type SuiteReport = {
	perf: ScenarioResult[];
	quality: QualityResult[];
};
