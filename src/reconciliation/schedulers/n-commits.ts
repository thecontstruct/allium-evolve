import type { ReconciliationContext, ReconciliationScheduler } from "../scheduler.js";

export class NCommitsScheduler implements ReconciliationScheduler {
	constructor(private interval: number) {}

	shouldReconcile(ctx: ReconciliationContext): boolean {
		return ctx.totalStepsCompleted - ctx.lastReconciliationStep >= this.interval;
	}
}
