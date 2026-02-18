import { describe, expect, it } from "vitest";
import type { EvolutionConfig } from "../../src/config.js";
import type { CommitNode, Segment } from "../../src/dag/types.js";
import { computeSetupStats, formatSetupStats } from "../../src/evolution/estimator.js";
import { StateTracker } from "../../src/state/tracker.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

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
		...overrides,
	};
}

function makeDag(nodes: CommitNode[]): Map<string, CommitNode> {
	const dag = new Map<string, CommitNode>();
	for (const node of nodes) {
		dag.set(node.sha, node);
	}
	return dag;
}

function makeNode(sha: string, parents: string[] = [], isTrunk = true): CommitNode {
	return {
		sha,
		parents,
		children: [],
		message: `commit ${sha}`,
		authorDate: "2025-01-01T00:00:00Z",
		isTrunk,
	};
}

let tmpDir: string;
let stateFilePath: string;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "allium-estimator-test-"));
	stateFilePath = join(tmpDir, "state.json");
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe("computeSetupStats", () => {
	it("counts commits, segments by type, and total steps", () => {
		const dag = makeDag([
			makeNode("a1"),
			makeNode("a2", ["a1"]),
			makeNode("a3", ["a2"]),
			makeNode("b1", ["a1"], false),
			makeNode("b2", ["b1"], false),
		]);

		const segments: Segment[] = [
			{ id: "trunk-0", type: "trunk", commits: ["a1", "a2", "a3"], forkFrom: null, mergesInto: null, dependsOn: [] },
			{ id: "branch-0", type: "branch", commits: ["b1", "b2"], forkFrom: "a1", mergesInto: null, dependsOn: ["trunk-0"] },
		];

		const tracker = new StateTracker(stateFilePath);
		tracker.initState(makeConfig(), segments, "a1");

		const stats = computeSetupStats(dag, segments, tracker, makeConfig(), false);

		expect(stats.totalCommits).toBe(5);
		expect(stats.totalSteps).toBe(5);
		expect(stats.segmentsByType["trunk"]).toEqual({ count: 1, commits: 3 });
		expect(stats.segmentsByType["branch"]).toEqual({ count: 1, commits: 2 });
	});

	it("identifies root commits as opus model and evolve as sonnet", () => {
		const dag = makeDag([
			makeNode("root"),
			makeNode("c2", ["root"]),
			makeNode("c3", ["c2"]),
		]);

		const segments: Segment[] = [
			{ id: "trunk-0", type: "trunk", commits: ["root", "c2", "c3"], forkFrom: null, mergesInto: null, dependsOn: [] },
		];

		const tracker = new StateTracker(stateFilePath);
		tracker.initState(makeConfig(), segments, "root");

		const stats = computeSetupStats(dag, segments, tracker, makeConfig(), false);

		expect(stats.modelDistribution["opus"]).toBe(1);
		expect(stats.modelDistribution["sonnet"]).toBe(2);
	});

	it("counts merge points for trunk segments starting with merge commits", () => {
		const dag = makeDag([
			makeNode("a1"),
			makeNode("a2", ["a1"]),
			makeNode("m1", ["a2", "b2"]),
			makeNode("b1", ["a1"], false),
			makeNode("b2", ["b1"], false),
		]);

		const segments: Segment[] = [
			{ id: "trunk-0", type: "trunk", commits: ["a1", "a2"], forkFrom: null, mergesInto: null, dependsOn: [] },
			{ id: "branch-0", type: "branch", commits: ["b1", "b2"], forkFrom: "a1", mergesInto: "m1", dependsOn: ["trunk-0"] },
			{ id: "trunk-1", type: "trunk", commits: ["m1"], forkFrom: null, mergesInto: null, dependsOn: ["trunk-0", "branch-0"] },
		];

		const tracker = new StateTracker(stateFilePath);
		tracker.initState(makeConfig(), segments, "a1");

		const stats = computeSetupStats(dag, segments, tracker, makeConfig(), false);

		expect(stats.mergePoints).toBe(1);
	});

	it("computes remaining steps accounting for completed work", () => {
		const dag = makeDag([
			makeNode("a1"),
			makeNode("a2", ["a1"]),
			makeNode("a3", ["a2"]),
		]);

		const segments: Segment[] = [
			{ id: "trunk-0", type: "trunk", commits: ["a1", "a2", "a3"], forkFrom: null, mergesInto: null, dependsOn: [] },
		];

		const tracker = new StateTracker(stateFilePath);
		tracker.initState(makeConfig(), segments, "a1");

		tracker.recordStep("trunk-0", {
			originalSha: "a1",
			alliumSha: "x1",
			model: "opus",
			costUsd: 0.15,
			timestamp: "2025-01-01T00:00:00Z",
		}, "spec v1", "log v1");

		const stats = computeSetupStats(dag, segments, tracker, makeConfig(), true);

		expect(stats.completedSteps).toBe(1);
		expect(stats.remainingSteps).toBe(2);
		expect(stats.costSoFar).toBeCloseTo(0.15);
		expect(stats.isResume).toBe(true);
	});

	it("computes critical path as longest dependency chain by commit count", () => {
		const dag = makeDag([
			makeNode("a1"),
			makeNode("a2", ["a1"]),
			makeNode("a3", ["a2"]),
			makeNode("b1", ["a1"], false),
			makeNode("m1", ["a3", "b1"]),
		]);

		const segments: Segment[] = [
			{ id: "trunk-0", type: "trunk", commits: ["a1", "a2", "a3"], forkFrom: null, mergesInto: null, dependsOn: [] },
			{ id: "branch-0", type: "branch", commits: ["b1"], forkFrom: "a1", mergesInto: "m1", dependsOn: ["trunk-0"] },
			{ id: "trunk-1", type: "trunk", commits: ["m1"], forkFrom: null, mergesInto: null, dependsOn: ["trunk-0", "branch-0"] },
		];

		const tracker = new StateTracker(stateFilePath);
		tracker.initState(makeConfig(), segments, "a1");

		const stats = computeSetupStats(dag, segments, tracker, makeConfig(), false);

		// trunk-0 (3) + branch-0 (1) + trunk-1 (1) = 5 via branch path
		// trunk-0 (3) + trunk-1 (1) = 4 via trunk path
		// Critical path = max = 5
		expect(stats.criticalPathSteps).toBe(5);
	});

	it("estimates cost range using model heuristics", () => {
		const dag = makeDag([
			makeNode("root"),
			makeNode("c2", ["root"]),
		]);

		const segments: Segment[] = [
			{ id: "trunk-0", type: "trunk", commits: ["root", "c2"], forkFrom: null, mergesInto: null, dependsOn: [] },
		];

		const tracker = new StateTracker(stateFilePath);
		tracker.initState(makeConfig(), segments, "root");

		const stats = computeSetupStats(dag, segments, tracker, makeConfig(), false);

		// 1 opus step (root): $0.05-$0.25, 1 sonnet step: $0.01-$0.05
		expect(stats.estimatedCost.low).toBeCloseTo(0.06, 2);
		expect(stats.estimatedCost.high).toBeCloseTo(0.30, 2);
	});

	it("provides wall-clock estimate using concurrency and critical path", () => {
		const dag = makeDag([
			makeNode("a1"),
			makeNode("a2", ["a1"]),
			makeNode("a3", ["a2"]),
			makeNode("a4", ["a3"]),
		]);

		const segments: Segment[] = [
			{ id: "trunk-0", type: "trunk", commits: ["a1", "a2", "a3", "a4"], forkFrom: null, mergesInto: null, dependsOn: [] },
		];

		const config = makeConfig({ maxConcurrency: 2 });
		const tracker = new StateTracker(stateFilePath);
		tracker.initState(config, segments, "a1");

		const stats = computeSetupStats(dag, segments, tracker, config, false);

		// critical path = 4, remaining/concurrency = 4/2 = 2
		// effective = max(4, 2) = 4
		expect(stats.estimatedWallClock.low).toBe(4 * 45);
		expect(stats.estimatedWallClock.high).toBe(4 * 90);
	});
});

describe("formatSetupStats", () => {
	it("includes all key sections in the output", () => {
		const dag = makeDag([
			makeNode("a1"),
			makeNode("a2", ["a1"]),
		]);

		const segments: Segment[] = [
			{ id: "trunk-0", type: "trunk", commits: ["a1", "a2"], forkFrom: null, mergesInto: null, dependsOn: [] },
		];

		const tracker = new StateTracker(stateFilePath);
		tracker.initState(makeConfig(), segments, "a1");

		const stats = computeSetupStats(dag, segments, tracker, makeConfig(), false);
		const output = formatSetupStats(stats);

		expect(output).toContain("allium-evolve setup summary");
		expect(output).toContain("NEW run");
		expect(output).toContain("Total commits:");
		expect(output).toContain("Segments:");
		expect(output).toContain("trunk");
		expect(output).toContain("Steps:");
		expect(output).toContain("Model distribution");
		expect(output).toContain("Cost estimate");
		expect(output).toContain("Time estimate");
		expect(output).toContain("Critical path:");
		expect(output).toContain("--setup-only");
	});

	it("shows resume info when isResume is true", () => {
		const dag = makeDag([
			makeNode("a1"),
			makeNode("a2", ["a1"]),
			makeNode("a3", ["a2"]),
		]);

		const segments: Segment[] = [
			{ id: "trunk-0", type: "trunk", commits: ["a1", "a2", "a3"], forkFrom: null, mergesInto: null, dependsOn: [] },
		];

		const tracker = new StateTracker(stateFilePath);
		tracker.initState(makeConfig(), segments, "a1");
		tracker.recordStep("trunk-0", {
			originalSha: "a1",
			alliumSha: "x1",
			model: "opus",
			costUsd: 0.12,
			timestamp: "2025-01-01T00:00:00Z",
		}, "spec", "log");

		const stats = computeSetupStats(dag, segments, tracker, makeConfig(), true);
		const output = formatSetupStats(stats);

		expect(output).toContain("RESUMING");
		expect(output).toContain("Completed:");
		expect(output).toContain("Spent so far:");
	});
});
