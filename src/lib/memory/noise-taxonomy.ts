// src/lib/memory/noise-taxonomy.ts
// Deprecation reasons that mark a capture as intake NOISE, as opposed to
// judgment-call retirements (superseded / consolidated / stale). Used by the
// advisory replay report's suppression denominator (spec §5). The replay-gate
// fixture labels are human judgments and never consult this predicate.
const NOISE_REASON_PATTERNS: RegExp[] = [
	/^one-off/i,
	/no[- ]durable/i,
	/^specific-bug-report/i,
	/session[- ]chatter/i,
	/^transient/i,
	/^noise\b/i,
	/^bulk-triage/i,
	/^aging: low-signal/i,
	/^intake: zero-signal/i,
];

export function isNoiseTaxonomyReason(
	reason: string | null | undefined,
): boolean {
	if (!reason) return false;
	const trimmed = reason.trim();
	return NOISE_REASON_PATTERNS.some((p) => p.test(trimmed));
}
