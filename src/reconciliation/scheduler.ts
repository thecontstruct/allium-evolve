import type { EvolutionConfig } from "../config.js";
import { NCommitsScheduler } from "./schedulers/n-commits.js";
import { NTrunkCommitsScheduler } from "./schedulers/n-trunk-commits.js";
import { TokenCountScheduler } from "./schedulers/token-count.js";

export interface ReconciliationContext {
	totalStepsCompleted: number;
	trunkStepsCompleted: number;
	cumulativeDiffTokensSinceLastReconciliation: number;
	segmentType: "trunk" | "branch" | "dead-end";
	lastReconciliationStep: number;
}

export interface ReconciliationScheduler {
	shouldReconcile(ctx: ReconciliationContext): boolean;
}

class NoOpScheduler implements ReconciliationScheduler {
	shouldReconcile(): boolean {
		return false;
	}
}

export function createScheduler(config: EvolutionConfig): ReconciliationScheduler {
	const { strategy, interval } = config.reconciliation;

	switch (strategy) {
		case "none":
			return new NoOpScheduler();
		case "n-commits":
			return new NCommitsScheduler(interval);
		case "n-trunk-commits":
			return new NTrunkCommitsScheduler(interval);
		case "token-count":
			return new TokenCountScheduler(interval);
		default:
			throw new Error(`Unknown reconciliation strategy: ${strategy}`);
	}
}
