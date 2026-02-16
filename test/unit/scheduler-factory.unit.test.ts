import { describe, expect, it } from "vitest";
import { createScheduler } from "../../src/reconciliation/scheduler.js";
import { defaultConfig } from "../../src/config.js";

describe("createScheduler factory", () => {
	it("should create a NoOp scheduler for 'none' strategy", () => {
		const config = defaultConfig({ reconciliation: { strategy: "none" } });
		const scheduler = createScheduler(config);
		expect(
			scheduler.shouldReconcile({
				totalStepsCompleted: 1000,
				trunkStepsCompleted: 1000,
				cumulativeDiffTokensSinceLastReconciliation: 999999,
				segmentType: "trunk",
				lastReconciliationStep: 0,
			}),
		).toBe(false);
	});

	it("should create NCommitsScheduler for 'n-commits' strategy", () => {
		const config = defaultConfig({ reconciliation: { strategy: "n-commits", interval: 3 } });
		const scheduler = createScheduler(config);
		expect(
			scheduler.shouldReconcile({
				totalStepsCompleted: 3,
				trunkStepsCompleted: 0,
				cumulativeDiffTokensSinceLastReconciliation: 0,
				segmentType: "branch",
				lastReconciliationStep: 0,
			}),
		).toBe(true);
	});

	it("should create NTrunkCommitsScheduler for 'n-trunk-commits' strategy", () => {
		const config = defaultConfig({ reconciliation: { strategy: "n-trunk-commits", interval: 3 } });
		const scheduler = createScheduler(config);
		expect(
			scheduler.shouldReconcile({
				totalStepsCompleted: 10,
				trunkStepsCompleted: 3,
				cumulativeDiffTokensSinceLastReconciliation: 0,
				segmentType: "trunk",
				lastReconciliationStep: 0,
			}),
		).toBe(true);
	});

	it("should create TokenCountScheduler for 'token-count' strategy", () => {
		const config = defaultConfig({ reconciliation: { strategy: "token-count", interval: 5000 } });
		const scheduler = createScheduler(config);
		expect(
			scheduler.shouldReconcile({
				totalStepsCompleted: 1,
				trunkStepsCompleted: 1,
				cumulativeDiffTokensSinceLastReconciliation: 5000,
				segmentType: "trunk",
				lastReconciliationStep: 0,
			}),
		).toBe(true);
	});

	it("should use default interval of 50", () => {
		const config = defaultConfig({ reconciliation: { strategy: "n-commits" } });
		const scheduler = createScheduler(config);
		expect(
			scheduler.shouldReconcile({
				totalStepsCompleted: 49,
				trunkStepsCompleted: 0,
				cumulativeDiffTokensSinceLastReconciliation: 0,
				segmentType: "trunk",
				lastReconciliationStep: 0,
			}),
		).toBe(false);
		expect(
			scheduler.shouldReconcile({
				totalStepsCompleted: 50,
				trunkStepsCompleted: 0,
				cumulativeDiffTokensSinceLastReconciliation: 0,
				segmentType: "trunk",
				lastReconciliationStep: 0,
			}),
		).toBe(true);
	});
});
