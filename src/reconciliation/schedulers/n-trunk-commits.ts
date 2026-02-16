import type { ReconciliationContext, ReconciliationScheduler } from "../scheduler.js";

export class NTrunkCommitsScheduler implements ReconciliationScheduler {
	constructor(private interval: number) {}

	shouldReconcile(ctx: ReconciliationContext): boolean {
		if (ctx.segmentType !== "trunk") {
			return false;
		}
		return ctx.trunkStepsCompleted - ctx.lastReconciliationStep >= this.interval;
	}
}
