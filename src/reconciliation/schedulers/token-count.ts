import type { ReconciliationContext, ReconciliationScheduler } from "../scheduler.js";

export class TokenCountScheduler implements ReconciliationScheduler {
	constructor(private threshold: number) {}

	shouldReconcile(ctx: ReconciliationContext): boolean {
		return ctx.cumulativeDiffTokensSinceLastReconciliation >= this.threshold;
	}
}
