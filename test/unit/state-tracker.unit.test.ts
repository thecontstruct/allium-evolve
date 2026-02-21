import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EvolutionConfig } from "../../src/config.js";
import type { Segment } from "../../src/dag/types.js";
import { StateTracker } from "../../src/state/tracker.js";
import type { CompletedMerge, CompletedStep } from "../../src/state/types.js";

function makeConfig(overrides: Partial<EvolutionConfig> = {}): EvolutionConfig {
	return {
		repoPath: "/tmp/test-repo",
		targetRef: "HEAD",
		windowSize: 5,
		processDepth: 1,
		defaultModel: "sonnet",
		opusModel: "opus",
		maxDiffTokens: 80000,
		parallelBranches: true,
		maxConcurrency: 4,
		stateFile: ".allium-state.json",
		alliumBranch: "allium/evolution",
		maxParseRetries: 2,
		diffIgnorePatterns: ["*-lock.*"],
		alliumSkillsPath: "/home/.claude/skills/allium",
		reconciliation: {
			strategy: "n-trunk-commits",
			interval: 50,
			sourceIgnorePatterns: [],
			maxConcurrency: 5,
		},
		...overrides,
	};
}

function makeSegments(): Segment[] {
	return [
		{
			id: "trunk-0",
			type: "trunk",
			commits: ["aaa111", "bbb222", "ccc333"],
			forkFrom: null,
			mergesInto: null,
			dependsOn: [],
		},
		{
			id: "branch-1",
			type: "branch",
			commits: ["ddd444", "eee555"],
			forkFrom: "aaa111",
			mergesInto: "ccc333",
			dependsOn: ["trunk-0"],
		},
	];
}

function makeStep(overrides: Partial<CompletedStep> = {}): CompletedStep {
	return {
		originalSha: "aaa111",
		alliumSha: "xxx999",
		model: "sonnet",
		costUsd: 0.05,
		timestamp: new Date().toISOString(),
		...overrides,
	};
}

let tmpDir: string;
let stateFilePath: string;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "allium-state-test-"));
	stateFilePath = join(tmpDir, "state.json");
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe("StateTracker", () => {
	describe("UNIT-024: initState creates correct initial state structure", () => {
		it("should create state with version 1 and all required fields", () => {
			const tracker = new StateTracker(stateFilePath);
			const config = makeConfig();
			const segments = makeSegments();

			tracker.initState(config, segments, "aaa111");

			const state = tracker.getState();
			expect(state.version).toBe(1);
			expect(state.repoPath).toBe(config.repoPath);
			expect(state.targetRef).toBe(config.targetRef);
			expect(state.rootCommit).toBe("aaa111");
			expect(state.config).toEqual(config);
			expect(state.segments).toEqual(segments);
			expect(state.completedMerges).toEqual([]);
			expect(state.shaMap).toEqual({});
			expect(state.alliumBranchHead).toBe("");
			expect(state.totalCostUsd).toBe(0);
			expect(state.totalSteps).toBe(0);
		});

		it("should initialize segmentProgress for each segment as pending", () => {
			const tracker = new StateTracker(stateFilePath);
			const config = makeConfig();
			const segments = makeSegments();

			tracker.initState(config, segments, "aaa111");

			const state = tracker.getState();
			expect(Object.keys(state.segmentProgress)).toHaveLength(2);
			for (const seg of segments) {
				const progress = state.segmentProgress[seg.id];
				expect(progress).toBeDefined();
				expect(progress!.status).toBe("pending");
				expect(progress!.completedSteps).toEqual([]);
				expect(progress!.currentSpec).toBe("");
				expect(progress!.currentChangelog).toBe("");
			}
		});
	});

	describe("UNIT-025: save/load roundtrip preserves state", () => {
		it("should write state to disk and read it back identically", async () => {
			const tracker = new StateTracker(stateFilePath);
			const config = makeConfig();
			const segments = makeSegments();

			tracker.initState(config, segments, "aaa111");
			tracker.recordStep("trunk-0", makeStep(), "spec v1", "changelog v1");

			await tracker.save();

			const tracker2 = new StateTracker(stateFilePath);
			const loaded = await tracker2.load();

			expect(loaded).toBe(true);
			expect(tracker2.getState()).toEqual(tracker.getState());
		});

		it("should create parent directories if they do not exist", async () => {
			const nested = join(tmpDir, "deep", "nested", "state.json");
			const tracker = new StateTracker(nested);
			tracker.initState(makeConfig(), makeSegments(), "aaa111");

			await tracker.save();

			const raw = await readFile(nested, "utf-8");
			expect(JSON.parse(raw).version).toBe(1);
		});

		it("should return false when state file does not exist", async () => {
			const tracker = new StateTracker(join(tmpDir, "nonexistent.json"));
			const loaded = await tracker.load();

			expect(loaded).toBe(false);
		});
	});

	describe("UNIT-026: recordStep updates segmentProgress and shaMap", () => {
		it("should append the step to the segment's completedSteps", () => {
			const tracker = new StateTracker(stateFilePath);
			tracker.initState(makeConfig(), makeSegments(), "aaa111");

			const step = makeStep();
			tracker.recordStep("trunk-0", step, "spec after step", "changelog after step");

			const progress = tracker.getSegmentProgress("trunk-0");
			expect(progress).toBeDefined();
			expect(progress!.completedSteps).toHaveLength(1);
			expect(progress!.completedSteps[0]).toEqual(step);
			expect(progress!.currentSpec).toBe("spec after step");
			expect(progress!.currentChangelog).toBe("changelog after step");
		});

		it("should add the originalSha -> alliumSha mapping to shaMap", () => {
			const tracker = new StateTracker(stateFilePath);
			tracker.initState(makeConfig(), makeSegments(), "aaa111");

			tracker.recordStep("trunk-0", makeStep({ originalSha: "aaa111", alliumSha: "xxx999" }), "", "");

			expect(tracker.getState().shaMap["aaa111"]).toBe("xxx999");
		});

		it("should set segment status to in-progress on first step", () => {
			const tracker = new StateTracker(stateFilePath);
			tracker.initState(makeConfig(), makeSegments(), "aaa111");

			tracker.recordStep("trunk-0", makeStep(), "spec", "log");

			expect(tracker.getSegmentProgress("trunk-0")!.status).toBe("in-progress");
		});
	});

	describe("UNIT-027: recordMerge updates completedMerges", () => {
		it("should append merge to completedMerges array", () => {
			const tracker = new StateTracker(stateFilePath);
			tracker.initState(makeConfig(), makeSegments(), "aaa111");

			const merge: CompletedMerge = {
				mergeSha: "merge111",
				alliumSha: "allium-merge111",
				trunkSegmentId: "trunk-0",
				branchSegmentId: "branch-1",
				timestamp: new Date().toISOString(),
			};

			tracker.recordMerge(merge);

			const state = tracker.getState();
			expect(state.completedMerges).toHaveLength(1);
			expect(state.completedMerges[0]).toEqual(merge);
		});

		it("should accumulate multiple merges", () => {
			const tracker = new StateTracker(stateFilePath);
			tracker.initState(makeConfig(), makeSegments(), "aaa111");

			tracker.recordMerge({
				mergeSha: "m1",
				alliumSha: "a1",
				trunkSegmentId: "trunk-0",
				branchSegmentId: "branch-1",
				timestamp: "2025-01-01T00:00:00Z",
			});
			tracker.recordMerge({
				mergeSha: "m2",
				alliumSha: "a2",
				trunkSegmentId: "trunk-0",
				branchSegmentId: "branch-1",
				timestamp: "2025-01-02T00:00:00Z",
			});

			expect(tracker.getState().completedMerges).toHaveLength(2);
		});
	});

	describe("UNIT-028: lookupAlliumSha returns correct mapping", () => {
		it("should return alliumSha for a recorded originalSha", () => {
			const tracker = new StateTracker(stateFilePath);
			tracker.initState(makeConfig(), makeSegments(), "aaa111");

			tracker.recordStep("trunk-0", makeStep({ originalSha: "aaa111", alliumSha: "xxx999" }), "", "");

			expect(tracker.lookupAlliumSha("aaa111")).toBe("xxx999");
		});

		it("should return undefined for an unknown sha", () => {
			const tracker = new StateTracker(stateFilePath);
			tracker.initState(makeConfig(), makeSegments(), "aaa111");

			expect(tracker.lookupAlliumSha("unknown")).toBeUndefined();
		});

		it("should provide O(1) lookup via shaMap", () => {
			const tracker = new StateTracker(stateFilePath);
			tracker.initState(makeConfig(), makeSegments(), "aaa111");

			// Record multiple steps
			tracker.recordStep("trunk-0", makeStep({ originalSha: "aaa111", alliumSha: "x1" }), "", "");
			tracker.recordStep("trunk-0", makeStep({ originalSha: "bbb222", alliumSha: "x2" }), "", "");
			tracker.recordStep("trunk-0", makeStep({ originalSha: "ccc333", alliumSha: "x3" }), "", "");

			// All lookups should work directly from the map
			expect(tracker.lookupAlliumSha("aaa111")).toBe("x1");
			expect(tracker.lookupAlliumSha("bbb222")).toBe("x2");
			expect(tracker.lookupAlliumSha("ccc333")).toBe("x3");
		});
	});

	describe("UNIT-029: updateSegmentStatus transitions correctly", () => {
		it("should transition from pending to in-progress", () => {
			const tracker = new StateTracker(stateFilePath);
			tracker.initState(makeConfig(), makeSegments(), "aaa111");

			tracker.updateSegmentStatus("trunk-0", "in-progress");

			expect(tracker.getSegmentProgress("trunk-0")!.status).toBe("in-progress");
		});

		it("should transition from in-progress to complete", () => {
			const tracker = new StateTracker(stateFilePath);
			tracker.initState(makeConfig(), makeSegments(), "aaa111");

			tracker.updateSegmentStatus("trunk-0", "in-progress");
			tracker.updateSegmentStatus("trunk-0", "complete");

			expect(tracker.getSegmentProgress("trunk-0")!.status).toBe("complete");
		});

		it("should transition from in-progress to failed", () => {
			const tracker = new StateTracker(stateFilePath);
			tracker.initState(makeConfig(), makeSegments(), "aaa111");

			tracker.updateSegmentStatus("trunk-0", "in-progress");
			tracker.updateSegmentStatus("trunk-0", "failed");

			expect(tracker.getSegmentProgress("trunk-0")!.status).toBe("failed");
		});

		it("should throw when updating an unknown segment", () => {
			const tracker = new StateTracker(stateFilePath);
			tracker.initState(makeConfig(), makeSegments(), "aaa111");

			expect(() => tracker.updateSegmentStatus("nonexistent", "in-progress")).toThrow();
		});
	});

	describe("UNIT-030: resume from partial state skips completed steps", () => {
		it("should preserve completed steps after save/load cycle", async () => {
			const tracker = new StateTracker(stateFilePath);
			tracker.initState(makeConfig(), makeSegments(), "aaa111");

			// Complete first two steps of trunk-0
			tracker.recordStep("trunk-0", makeStep({ originalSha: "aaa111", alliumSha: "x1" }), "spec1", "log1");
			tracker.recordStep("trunk-0", makeStep({ originalSha: "bbb222", alliumSha: "x2" }), "spec2", "log2");

			await tracker.save();

			// Simulate resume: load into new tracker
			const resumed = new StateTracker(stateFilePath);
			await resumed.load();

			const progress = resumed.getSegmentProgress("trunk-0")!;
			expect(progress.completedSteps).toHaveLength(2);

			// Third commit ccc333 is not yet completed - can resume from here
			const completedShas = progress.completedSteps.map((s) => s.originalSha);
			expect(completedShas).toContain("aaa111");
			expect(completedShas).toContain("bbb222");
			expect(completedShas).not.toContain("ccc333");
		});

		it("should skip fully completed segments on resume", async () => {
			const tracker = new StateTracker(stateFilePath);
			tracker.initState(makeConfig(), makeSegments(), "aaa111");

			// Complete all steps of trunk-0
			tracker.recordStep("trunk-0", makeStep({ originalSha: "aaa111", alliumSha: "x1" }), "s1", "l1");
			tracker.recordStep("trunk-0", makeStep({ originalSha: "bbb222", alliumSha: "x2" }), "s2", "l2");
			tracker.recordStep("trunk-0", makeStep({ originalSha: "ccc333", alliumSha: "x3" }), "s3", "l3");
			tracker.updateSegmentStatus("trunk-0", "complete");

			await tracker.save();

			const resumed = new StateTracker(stateFilePath);
			await resumed.load();

			expect(resumed.getSegmentProgress("trunk-0")!.status).toBe("complete");
			// branch-1 should still be pending
			expect(resumed.getSegmentProgress("branch-1")!.status).toBe("pending");
		});
	});

	describe("UNIT-031: failed segment handling", () => {
		it("should preserve failed status across save/load", async () => {
			const tracker = new StateTracker(stateFilePath);
			tracker.initState(makeConfig(), makeSegments(), "aaa111");

			tracker.recordStep("trunk-0", makeStep({ originalSha: "aaa111", alliumSha: "x1" }), "s1", "l1");
			tracker.updateSegmentStatus("trunk-0", "failed");

			await tracker.save();

			const resumed = new StateTracker(stateFilePath);
			await resumed.load();

			expect(resumed.getSegmentProgress("trunk-0")!.status).toBe("failed");
			expect(resumed.getSegmentProgress("trunk-0")!.completedSteps).toHaveLength(1);
		});

		it("should allow retry by recording new steps on a failed segment", () => {
			const tracker = new StateTracker(stateFilePath);
			tracker.initState(makeConfig(), makeSegments(), "aaa111");

			// Partial progress then failure
			tracker.recordStep("trunk-0", makeStep({ originalSha: "aaa111", alliumSha: "x1" }), "s1", "l1");
			tracker.updateSegmentStatus("trunk-0", "failed");

			// Retry: update status back to in-progress and record the next step
			tracker.updateSegmentStatus("trunk-0", "in-progress");
			tracker.recordStep("trunk-0", makeStep({ originalSha: "bbb222", alliumSha: "x2" }), "s2", "l2");

			const progress = tracker.getSegmentProgress("trunk-0")!;
			expect(progress.status).toBe("in-progress");
			expect(progress.completedSteps).toHaveLength(2);
		});
	});

	describe("UNIT-032: totalCostUsd accumulates across steps", () => {
		it("should accumulate cost from multiple steps across segments", () => {
			const tracker = new StateTracker(stateFilePath);
			tracker.initState(makeConfig(), makeSegments(), "aaa111");

			tracker.recordStep("trunk-0", makeStep({ originalSha: "aaa111", costUsd: 0.05 }), "", "");
			tracker.recordStep("trunk-0", makeStep({ originalSha: "bbb222", costUsd: 0.1 }), "", "");
			tracker.recordStep("branch-1", makeStep({ originalSha: "ddd444", costUsd: 0.03 }), "", "");

			const state = tracker.getState();
			expect(state.totalCostUsd).toBeCloseTo(0.18, 10);
			expect(state.totalSteps).toBe(3);
		});

		it("should preserve accumulated cost after save/load", async () => {
			const tracker = new StateTracker(stateFilePath);
			tracker.initState(makeConfig(), makeSegments(), "aaa111");

			tracker.recordStep("trunk-0", makeStep({ costUsd: 0.25 }), "", "");
			tracker.recordStep("trunk-0", makeStep({ originalSha: "bbb222", costUsd: 0.75 }), "", "");

			await tracker.save();

			const resumed = new StateTracker(stateFilePath);
			await resumed.load();

			expect(resumed.getState().totalCostUsd).toBeCloseTo(1.0, 10);
			expect(resumed.getState().totalSteps).toBe(2);
		});
	});

	describe("UNIT-033: setShaMap and seedSegmentProgress for --start-after", () => {
		it("setShaMap replaces shaMap", () => {
			const tracker = new StateTracker(stateFilePath);
			tracker.initState(makeConfig(), makeSegments(), "aaa111");
			tracker.recordStep("trunk-0", makeStep({ originalSha: "aaa111", alliumSha: "x1" }), "", "");

			tracker.setShaMap({ aaa111: "y1", bbb222: "y2" });

			expect(tracker.getState().shaMap).toEqual({ aaa111: "y1", bbb222: "y2" });
		});

		it("seedSegmentProgress sets progress and increments totalSteps", () => {
			const tracker = new StateTracker(stateFilePath);
			tracker.initState(makeConfig(), makeSegments(), "aaa111");

			const step: CompletedStep = {
				originalSha: "ccc333",
				alliumSha: "z3",
				model: "seeded",
				costUsd: 0,
				timestamp: new Date().toISOString(),
			};
			tracker.seedSegmentProgress(
				"trunk-0",
				{
					status: "complete",
					completedSteps: [step],
					currentSpec: "entity User {}",
					currentChangelog: "# Changelog",
				},
				3,
			);

			const progress = tracker.getSegmentProgress("trunk-0")!;
			expect(progress.status).toBe("complete");
			expect(progress.completedSteps).toHaveLength(1);
			expect(progress.completedSteps[0]!.originalSha).toBe("ccc333");
			expect(progress.currentSpec).toBe("entity User {}");
			expect(tracker.getState().totalSteps).toBe(3);
		});

		it("seedSegmentProgress throws for unknown segment", () => {
			const tracker = new StateTracker(stateFilePath);
			tracker.initState(makeConfig(), makeSegments(), "aaa111");

			expect(() =>
				tracker.seedSegmentProgress(
					"nonexistent",
					{ status: "complete", completedSteps: [], currentSpec: "", currentChangelog: "" },
					0,
				),
			).toThrow("Unknown segment");
		});
	});
});
