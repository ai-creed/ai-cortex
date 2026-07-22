// src/lib/memory/drain.ts
// P2 backlog drain (one-time bulk triage): retroactively applies the intake
// gate to already-stored candidate captures. Pure decision logic; the
// scripts/drain-backlog.ts shell owns I/O and mutation.
//
// Scoring happens at the ROUTED-PROMPT layer via routedPromptFromBody: stored
// capture bodies are `prompt + "\n\n_Acknowledged:_ <echo>"`, and scoring the
// composed body lets an assistant echo inflate a junk prompt's signal (the
// exact defect the replay gate pins). Keeper bodies from the harvest corpus
// are exempt before any scoring so the drain cannot destroy a known gem.
import { structuralReject, captureTier } from "./gate.js";
import { routedPromptFromBody } from "./extract.js";

export const DRAIN_REASON = "bulk-triage-2026-07-intake-filter-match";

export type DrainDecision =
	| { action: "trash"; rule: string }
	| { action: "keep"; why: "not-candidate-capture" | "keeper-exempt" | "high-tier" };

export function decideDrain(
	rec: { status: string; type: string; body: string },
	keeperBodies: ReadonlySet<string>,
): DrainDecision {
	if (rec.status !== "candidate" || rec.type !== "capture") {
		return { action: "keep", why: "not-candidate-capture" };
	}
	if (keeperBodies.has(rec.body.trim())) {
		return { action: "keep", why: "keeper-exempt" };
	}
	const prompt = routedPromptFromBody(rec.body);
	const rule = structuralReject(prompt);
	if (rule !== null) {
		return { action: "trash", rule };
	}
	if (captureTier(prompt) === "low") {
		return { action: "trash", rule: "low-tier" };
	}
	return { action: "keep", why: "high-tier" };
}
