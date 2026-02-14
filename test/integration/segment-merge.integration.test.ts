import { exec as cpExec } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const execAsync = promisify(cpExec);

// Mock the Claude runner BEFORE importing modules that use it
vi.mock("../../src/claude/runner.js", () => {
	let callCount = 0;
	return {
		invokeClaudeForStep: vi.fn(async () => {
			callCount++;
			return {
				spec: `spec-v${callCount}`,
				changelog: `changelog entry ${callCount}`,
				commitMessage: `evolve step ${callCount}`,
				sessionId: `session-${callCount}`,
				costUsd: 0.01,
			};
		}),
		invokeClaudeForChunk: vi.fn(async () => ({
			specPatch: "chunk patch",
			sectionsChanged: ["section1"],
			sessionId: "",
			costUsd: 0,
		})),
	};
});

const FIXTURE_REPO = resolve(import.meta.dirname, "../fixtures/repo");

describe("Segment runner + Merge runner isolation", () => {
	let tmpDir: string;
	let repoPath: string;

	// Loaded after mocks are configured
	let buildDag: typeof import("../../src/dag/builder.js").buildDag;
	let identifyTrunk: typeof import("../../src/dag/trunk.js").identifyTrunk;
	let decompose: typeof import("../../src/dag/segments.js").decompose;
	let runSegment: typeof import("../../src/evolution/segment-runner.js").runSegment;
	let runMerge: typeof import("../../src/evolution/merge-runner.js").runMerge;
	let defaultConfig: typeof import("../../src/config.js").defaultConfig;

	type CommitNode = import("../../src/dag/types.js").CommitNode;
	type Segment = import("../../src/dag/types.js").Segment;
	type EvolutionConfig = import("../../src/config.js").EvolutionConfig;

	let dag: Map<string, CommitNode>;
	let segments: Segment[];
	let config: EvolutionConfig;

	function segmentContaining(prefix: string): Segment {
		for (const node of dag.values()) {
			if (node.message.startsWith(prefix)) {
				const seg = segments.find((s) => s.commits.includes(node.sha));
				if (seg) {
					return seg;
				}
			}
		}
		throw new Error(`No segment contains commit with prefix: ${prefix}`);
	}

	function shaByPrefix(prefix: string): string {
		for (const node of dag.values()) {
			if (node.message.startsWith(prefix)) {
				return node.sha;
			}
		}
		throw new Error(`No commit with prefix: ${prefix}`);
	}

	beforeAll(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "allium-seg-merge-"));
		repoPath = join(tmpDir, "repo");

		await cp(FIXTURE_REPO, repoPath, { recursive: true });

		await execAsync('git config user.email "test@allium-evolve.dev"', { cwd: repoPath });
		await execAsync('git config user.name "Test Author"', { cwd: repoPath });

		// Dynamic imports after mock setup
		const dagBuilder = await import("../../src/dag/builder.js");
		const dagTrunk = await import("../../src/dag/trunk.js");
		const dagSegments = await import("../../src/dag/segments.js");
		const segRunner = await import("../../src/evolution/segment-runner.js");
		const mergeRunner = await import("../../src/evolution/merge-runner.js");
		const configMod = await import("../../src/config.js");

		buildDag = dagBuilder.buildDag;
		identifyTrunk = dagTrunk.identifyTrunk;
		decompose = dagSegments.decompose;
		runSegment = segRunner.runSegment;
		runMerge = mergeRunner.runMerge;
		defaultConfig = configMod.defaultConfig;

		dag = await buildDag(repoPath);
		await identifyTrunk(dag, repoPath, "main");
		segments = decompose(dag);

		config = defaultConfig({
			repoPath,
			targetRef: "main",
			parallelBranches: false,
			stateFile: join(tmpDir, "state.json"),
			alliumBranch: "allium/evolution",
			alliumSkillsPath: "/tmp/fake-skills",
		});
	}, 60_000);

	afterAll(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	describe("INT-008: Segment runner creates correct number of allium commits", () => {
		it("should create one allium commit per original commit in trunk-0 (A, B, C)", async () => {
			const trunkSeg = segmentContaining("A:");
			expect(trunkSeg.commits).toHaveLength(3);

			const result = await runSegment({
				segment: trunkSeg,
				config,
				dag,
				initialSpec: "",
				initialChangelog: "",
				parentAlliumSha: null,
			});

			expect(result.completedSteps).toHaveLength(3);
			// Each step should have a distinct alliumSha
			const shas = new Set(result.completedSteps.map((s) => s.alliumSha));
			expect(shas.size).toBe(3);
		});
	});

	describe("INT-009: Allium commits contain spec.allium file", () => {
		it("should have spec.allium in the tree of each allium commit", async () => {
			const trunkSeg = segmentContaining("A:");
			const result = await runSegment({
				segment: trunkSeg,
				config,
				dag,
				initialSpec: "",
				initialChangelog: "",
				parentAlliumSha: null,
			});

			for (const step of result.completedSteps) {
				const { stdout } = await execAsync(`git ls-tree ${step.alliumSha} -- spec.allium`, { cwd: repoPath });
				expect(stdout.trim()).toContain("spec.allium");
			}
		});
	});

	describe("INT-010: Allium commits contain allium-changelog.md", () => {
		it("should have allium-changelog.md in the tree of each allium commit", async () => {
			const trunkSeg = segmentContaining("A:");
			const result = await runSegment({
				segment: trunkSeg,
				config,
				dag,
				initialSpec: "",
				initialChangelog: "",
				parentAlliumSha: null,
			});

			for (const step of result.completedSteps) {
				const { stdout } = await execAsync(`git ls-tree ${step.alliumSha} -- allium-changelog.md`, { cwd: repoPath });
				expect(stdout.trim()).toContain("allium-changelog.md");
			}
		});
	});

	describe("INT-011: Merge runner creates commit with two parents", () => {
		it("should create an allium merge commit with exactly 2 parents", async () => {
			// First, run trunk-0 to get the trunk result
			const trunkSeg = segmentContaining("A:");
			const trunkResult = await runSegment({
				segment: trunkSeg,
				config,
				dag,
				initialSpec: "",
				initialChangelog: "",
				parentAlliumSha: null,
			});

			// Then run branch-0 (X1, X2) to get the branch result
			const branchSeg = segmentContaining("X1:");
			const branchResult = await runSegment({
				segment: branchSeg,
				config,
				dag,
				initialSpec: trunkResult.currentSpec,
				initialChangelog: trunkResult.currentChangelog,
				parentAlliumSha: trunkResult.tipAlliumSha,
			});

			// Now run the merge for M1
			const m1Sha = shaByPrefix("M1:");
			const mergeResult = await runMerge({
				mergeSha: m1Sha,
				trunkSpec: trunkResult.currentSpec,
				branchSpec: branchResult.currentSpec,
				trunkChangelog: trunkResult.currentChangelog,
				branchChangelog: branchResult.currentChangelog,
				trunkAlliumSha: trunkResult.tipAlliumSha,
				branchAlliumSha: branchResult.tipAlliumSha,
				trunkSegmentId: trunkSeg.id,
				branchSegmentId: branchSeg.id,
				config,
				dag,
			});

			// Verify the merge commit has 2 parents
			const { stdout } = await execAsync(`git cat-file -p ${mergeResult.alliumSha}`, { cwd: repoPath });
			const parentLines = stdout.split("\n").filter((line) => line.startsWith("parent "));
			expect(parentLines).toHaveLength(2);
		});
	});

	describe("INT-012: Merged spec content reflects Claude mock output", () => {
		it("should have mergedSpec matching the latest mock spec output", async () => {
			const trunkSeg = segmentContaining("A:");
			const trunkResult = await runSegment({
				segment: trunkSeg,
				config,
				dag,
				initialSpec: "",
				initialChangelog: "",
				parentAlliumSha: null,
			});

			const branchSeg = segmentContaining("X1:");
			const branchResult = await runSegment({
				segment: branchSeg,
				config,
				dag,
				initialSpec: trunkResult.currentSpec,
				initialChangelog: trunkResult.currentChangelog,
				parentAlliumSha: trunkResult.tipAlliumSha,
			});

			const m1Sha = shaByPrefix("M1:");
			const mergeResult = await runMerge({
				mergeSha: m1Sha,
				trunkSpec: trunkResult.currentSpec,
				branchSpec: branchResult.currentSpec,
				trunkChangelog: trunkResult.currentChangelog,
				branchChangelog: branchResult.currentChangelog,
				trunkAlliumSha: trunkResult.tipAlliumSha,
				branchAlliumSha: branchResult.tipAlliumSha,
				trunkSegmentId: trunkSeg.id,
				branchSegmentId: branchSeg.id,
				config,
				dag,
			});

			// The mergedSpec should be a spec-vN from the mock
			expect(mergeResult.mergedSpec).toMatch(/^spec-v\d+$/);

			// The mergedChangelog should contain "changelog entry" from the mock
			expect(mergeResult.mergedChangelog).toContain("changelog entry");

			// Verify the spec content is stored in the allium commit's tree
			const { stdout } = await execAsync(`git cat-file -p ${mergeResult.alliumSha}:spec.allium`, { cwd: repoPath });
			expect(stdout).toMatch(/^spec-v\d+$/);
		});
	});
});
