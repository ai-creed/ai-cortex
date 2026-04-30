import type { BlastHit, CallEdge, FunctionNode } from "./models.js";

export type BlastRadiusResult = {
	target: { qualifiedName: string; file: string; exported: boolean };
	totalAffected: number;
	unresolvedEdges: number;
	confidence: "full" | "partial";
	tiers: BlastTier[];
	overloadCount?: number;
};

export type BlastTier = {
	hop: number;
	label: string;
	hits: BlastHit[];
};

export function queryBlastRadius(
	target: { qualifiedName: string; file: string },
	calls: CallEdge[],
	functions: FunctionNode[],
	options?: { maxHops?: number },
): BlastRadiusResult {
	const maxHops = options?.maxHops ?? 5;
	const targetKey = `${target.file}::${target.qualifiedName}`;

	const matchingFns = functions.filter(
		(f) => f.file === target.file && f.qualifiedName === target.qualifiedName,
	);
	const exported = matchingFns.some((f) => f.exported);
	const overloadCount = matchingFns.length > 1 ? matchingFns.length : undefined;

	// Build reverse adjacency: callee -> callers
	const reverseAdj = new Map<string, Set<string>>();
	for (const edge of calls) {
		if (edge.to.startsWith("::")) continue;
		let callers = reverseAdj.get(edge.to);
		if (!callers) {
			callers = new Set();
			reverseAdj.set(edge.to, callers);
		}
		callers.add(edge.from);
	}

	// BFS from target
	const visited = new Set<string>();
	visited.add(targetKey);
	const hitsByHop = new Map<number, BlastHit[]>();
	let frontier = [targetKey];
	let hop = 0;

	while (frontier.length > 0 && hop < maxHops) {
		hop++;
		const nextFrontier: string[] = [];
		for (const key of frontier) {
			const callers = reverseAdj.get(key);
			if (!callers) continue;
			for (const caller of callers) {
				if (visited.has(caller)) continue;
				visited.add(caller);
				nextFrontier.push(caller);

				const sepIdx = caller.indexOf("::");
				const callerFile = caller.slice(0, sepIdx);
				const callerName = caller.slice(sepIdx + 2);
				const callerFunc = functions.find(
					(f) => f.file === callerFile && f.qualifiedName === callerName,
				);

				const hit: BlastHit = {
					qualifiedName: callerName,
					file: callerFile,
					hop,
					exported: callerFunc?.exported ?? false,
				};

				const hitsAtHop = hitsByHop.get(hop) ?? [];
				hitsAtHop.push(hit);
				hitsByHop.set(hop, hitsAtHop);
			}
		}
		frontier = nextFrontier;
	}

	// Build tiers
	const tiers: BlastTier[] = [];
	for (const [h, hits] of [...hitsByHop.entries()].sort(
		(a, b) => a[0] - b[0],
	)) {
		const sorted = hits.sort(
			(a, b) =>
				a.file.localeCompare(b.file) ||
				a.qualifiedName.localeCompare(b.qualifiedName),
		);
		tiers.push({
			hop: h,
			label: h === 1 ? "direct callers" : `transitive callers (${h} hops)`,
			hits: sorted,
		});
	}

	const totalAffected = tiers.reduce((sum, t) => sum + t.hits.length, 0);

	// Count unresolved edges that could plausibly match target
	const targetMethodPortion = target.qualifiedName.includes(".")
		? target.qualifiedName.slice(target.qualifiedName.lastIndexOf(".") + 1)
		: null;

	let unresolvedEdges = 0;
	for (const edge of calls) {
		if (!edge.to.startsWith("::")) continue;
		const unresolvedName = edge.to.slice(2);
		if (unresolvedName === target.qualifiedName) {
			unresolvedEdges++;
		} else if (targetMethodPortion && unresolvedName === targetMethodPortion) {
			unresolvedEdges++;
		}
	}

	return {
		target: {
			qualifiedName: target.qualifiedName,
			file: target.file,
			exported,
		},
		totalAffected,
		unresolvedEdges,
		confidence: unresolvedEdges === 0 ? "full" : "partial",
		tiers,
		overloadCount,
	};
}
