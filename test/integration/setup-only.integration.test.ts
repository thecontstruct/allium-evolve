import { exec as cpExec } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/config.js";
import { computeSetupStats, formatSetupStats } from "../../src/evolution/estimator.js";
import { setupEvolution } from "../../src/evolution/orchestrator.js";

const execAsync = promisify(cpExec);

const FIXTURE_REPO = resolve(import.meta.dirname, "../fixtures/repo");

describe("setupEvolution – setup-only mode", () => {
	let tmpDir: string;
	let repoPath: string;
	let stateFilePath: string;

	beforeAll(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "allium-setup-only-"));
		repoPath = join(tmpDir, "repo");
		stateFilePath = join(tmpDir, "state.json");

		await cp(FIXTURE_REPO, repoPath, { recursive: true });
		await execAsync('git config user.email "test@allium-evolve.dev"', { cwd: repoPath });
		await execAsync('git config user.name "Test Author"', { cwd: repoPath });
	}, 30_000);

	afterAll(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	describe("INT-SETUP-001: setupEvolution completes without invoking any LLM calls", () => {
		it("should return dag, segments, stateTracker, and rootCommit", async () => {
			const config = defaultConfig({
				repoPath,
				targetRef: "master",
				parallelBranches: false,
				stateFile: stateFilePath,
				alliumBranch: "allium/setup-test",
				alliumSkillsPath: "/tmp/fake-skills",
			});

			const result = await setupEvolution(config);

			expect(result.dag.size).toBeGreaterThan(0);
			expect(result.segments.length).toBeGreaterThan(0);
			expect(result.rootCommit).toMatch(/^[0-9a-f]+$/);
			expect(result.stateTracker).toBeDefined();
			expect(result.isResume).toBe(false);
		});
	});

	describe("INT-SETUP-002: State file is created with all segments pending", () => {
		it("should persist state file to disk", async () => {
			const raw = await readFile(stateFilePath, "utf-8");
			const state = JSON.parse(raw);
			expect(state.version).toBe(1);
		});

		it("should have all segments in pending status", async () => {
			const raw = await readFile(stateFilePath, "utf-8");
			const state = JSON.parse(raw);
			const progressEntries = Object.values(state.segmentProgress) as Array<{ status: string }>;
			expect(progressEntries.length).toBeGreaterThan(0);
			for (const entry of progressEntries) {
				expect(entry.status).toBe("pending");
			}
		});

		it("should have zero completed steps and zero cost", async () => {
			const raw = await readFile(stateFilePath, "utf-8");
			const state = JSON.parse(raw);
			expect(state.totalSteps).toBe(0);
			expect(state.totalCostUsd).toBe(0);
		});
	});

	describe("INT-SETUP-003: No allium commits or branch created", () => {
		it("should not create the allium branch ref", async () => {
			try {
				await execAsync("git rev-parse refs/heads/allium/setup-test", { cwd: repoPath });
				expect.fail("allium branch should not exist after setup-only");
			} catch {
				// Expected: ref does not exist
			}
		});
	});

	describe("INT-SETUP-004: Stats output includes all expected fields", () => {
		it("should produce stats with correct structure", async () => {
			const config = defaultConfig({
				repoPath,
				targetRef: "master",
				parallelBranches: false,
				stateFile: stateFilePath,
				alliumBranch: "allium/setup-test",
				alliumSkillsPath: "/tmp/fake-skills",
			});

			const result = await setupEvolution(config);
			const stats = computeSetupStats(result.dag, result.segments, result.stateTracker, config, result.isResume);

			expect(stats.totalCommits).toBe(28);
			expect(stats.totalSteps).toBe(28);
			expect(stats.completedSteps).toBe(0);
			expect(stats.remainingSteps).toBe(28);
			expect(stats.mergePoints).toBeGreaterThanOrEqual(1);
			expect(stats.criticalPathSteps).toBeGreaterThan(0);
			expect(stats.estimatedCost.low).toBeGreaterThan(0);
			expect(stats.estimatedCost.high).toBeGreaterThan(stats.estimatedCost.low);
			expect(stats.estimatedWallClock.low).toBeGreaterThan(0);
		});

		it("should format stats with all sections", async () => {
			const config = defaultConfig({
				repoPath,
				targetRef: "master",
				parallelBranches: false,
				stateFile: stateFilePath,
				alliumBranch: "allium/setup-test",
				alliumSkillsPath: "/tmp/fake-skills",
			});

			const result = await setupEvolution(config);
			const stats = computeSetupStats(result.dag, result.segments, result.stateTracker, config, result.isResume);
			const output = formatSetupStats(stats);

			expect(output).toContain("Total commits:");
			expect(output).toContain("28");
			expect(output).toContain("trunk");
			expect(output).toContain("Remaining:");
			expect(output).toContain("Cost estimate");
			expect(output).toContain("Time estimate");
		});
	});

	describe("INT-SETUP-005: Resume detects existing state", () => {
		it("should detect resume on second call", async () => {
			const config = defaultConfig({
				repoPath,
				targetRef: "master",
				parallelBranches: false,
				stateFile: stateFilePath,
				alliumBranch: "allium/setup-test",
				alliumSkillsPath: "/tmp/fake-skills",
			});

			const result = await setupEvolution(config);
			expect(result.isResume).toBe(true);
		});
	});
});
