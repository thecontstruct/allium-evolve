import { describe, expect, it } from "vitest";
import { NCommitsScheduler } from "../../src/reconciliation/schedulers/n-commits.js";
import { NTrunkCommitsScheduler } from "../../src/reconciliation/schedulers/n-trunk-commits.js";
import { TokenCountScheduler } from "../../src/reconciliation/schedulers/token-count.js";
import type { ReconciliationContext } from "../../src/reconciliation/scheduler.js";

function makeCtx(overrides: Partial<ReconciliationContext> = {}): ReconciliationContext {
	return {
		totalStepsCompleted: 0,
		trunkStepsCompleted: 0,
		cumulativeDiffTokensSinceLastReconciliation: 0,
		segmentType: "trunk",
		lastReconciliationStep: 0,
		...overrides,
	};
}

describe("NCommitsScheduler", () => {
	it("should not reconcile before interval is reached", () => {
		const scheduler = new NCommitsScheduler(5);
		expect(scheduler.shouldReconcile(makeCtx({ totalStepsCompleted: 4 }))).toBe(false);
	});

	it("should reconcile when interval is reached", () => {
		const scheduler = new NCommitsScheduler(5);
		expect(scheduler.shouldReconcile(makeCtx({ totalStepsCompleted: 5 }))).toBe(true);
	});

	it("should reconcile when interval is exceeded", () => {
		const scheduler = new NCommitsScheduler(5);
		expect(scheduler.shouldReconcile(makeCtx({ totalStepsCompleted: 8 }))).toBe(true);
	});

	it("should account for lastReconciliationStep offset", () => {
		const scheduler = new NCommitsScheduler(5);
		expect(
			scheduler.shouldReconcile(makeCtx({ totalStepsCompleted: 12, lastReconciliationStep: 10 })),
		).toBe(false);
		expect(
			scheduler.shouldReconcile(makeCtx({ totalStepsCompleted: 15, lastReconciliationStep: 10 })),
		).toBe(true);
	});

	it("should reconcile on any segment type", () => {
		const scheduler = new NCommitsScheduler(3);
		expect(
			scheduler.shouldReconcile(makeCtx({ totalStepsCompleted: 3, segmentType: "branch" })),
		).toBe(true);
		expect(
			scheduler.shouldReconcile(makeCtx({ totalStepsCompleted: 3, segmentType: "dead-end" })),
		).toBe(true);
	});
});

describe("NTrunkCommitsScheduler", () => {
	it("should not reconcile on non-trunk segments", () => {
		const scheduler = new NTrunkCommitsScheduler(3);
		expect(
			scheduler.shouldReconcile(makeCtx({ trunkStepsCompleted: 5, segmentType: "branch" })),
		).toBe(false);
		expect(
			scheduler.shouldReconcile(makeCtx({ trunkStepsCompleted: 5, segmentType: "dead-end" })),
		).toBe(false);
	});

	it("should not reconcile before interval on trunk", () => {
		const scheduler = new NTrunkCommitsScheduler(5);
		expect(
			scheduler.shouldReconcile(makeCtx({ trunkStepsCompleted: 4, segmentType: "trunk" })),
		).toBe(false);
	});

	it("should reconcile when trunk interval is reached", () => {
		const scheduler = new NTrunkCommitsScheduler(5);
		expect(
			scheduler.shouldReconcile(makeCtx({ trunkStepsCompleted: 5, segmentType: "trunk" })),
		).toBe(true);
	});

	it("should account for lastReconciliationStep offset on trunk", () => {
		const scheduler = new NTrunkCommitsScheduler(5);
		expect(
			scheduler.shouldReconcile(
				makeCtx({ trunkStepsCompleted: 12, lastReconciliationStep: 10, segmentType: "trunk" }),
			),
		).toBe(false);
		expect(
			scheduler.shouldReconcile(
				makeCtx({ trunkStepsCompleted: 15, lastReconciliationStep: 10, segmentType: "trunk" }),
			),
		).toBe(true);
	});
});

describe("TokenCountScheduler", () => {
	it("should not reconcile below threshold", () => {
		const scheduler = new TokenCountScheduler(10000);
		expect(
			scheduler.shouldReconcile(makeCtx({ cumulativeDiffTokensSinceLastReconciliation: 9999 })),
		).toBe(false);
	});

	it("should reconcile at threshold", () => {
		const scheduler = new TokenCountScheduler(10000);
		expect(
			scheduler.shouldReconcile(makeCtx({ cumulativeDiffTokensSinceLastReconciliation: 10000 })),
		).toBe(true);
	});

	it("should reconcile above threshold", () => {
		const scheduler = new TokenCountScheduler(10000);
		expect(
			scheduler.shouldReconcile(makeCtx({ cumulativeDiffTokensSinceLastReconciliation: 15000 })),
		).toBe(true);
	});

	it("should reconcile regardless of segment type", () => {
		const scheduler = new TokenCountScheduler(100);
		expect(
			scheduler.shouldReconcile(
				makeCtx({ cumulativeDiffTokensSinceLastReconciliation: 200, segmentType: "branch" }),
			),
		).toBe(true);
	});
});
