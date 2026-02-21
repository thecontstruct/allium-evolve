import { exec as cpExec } from "node:child_process";
import { access, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config.js";
import { computeSetupStats, formatSetupStats } from "../../src/evolution/estimator.js";
import { runEvolution, setupEvolution } from "../../src/evolution/orchestrator.js";
import { formatOriginalLine } from "../../src/git/commit-metadata.js";

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
				targetRef: "main",
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

	describe("INT-SETUP-002: setupEvolution does not write state file (dry-run semantics)", () => {
		it("should NOT persist a state file to disk after setupEvolution", async () => {
			// After F2 fix: stateTracker.save() is only called from runEvolution (post-confirmation).
			// setupEvolution is a pure analysis function that must not write state.
			await expect(access(stateFilePath)).rejects.toThrow();
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
				targetRef: "main",
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
				targetRef: "main",
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

	describe("INT-SETUP-005: Resume detects existing state after runEvolution writes state file", () => {
		it("should detect resume when state file exists from a prior run", async () => {
			// runEvolution (with autoConfirm) writes the state file; setupEvolution then detects it on the next call.
			const resumeStateFile = join(tmpDir, "state-resume-test.json");
			const { ShutdownSignal } = await import("../../src/shutdown.js");
			const config = defaultConfig({
				repoPath,
				targetRef: "main",
				parallelBranches: false,
				stateFile: resumeStateFile,
				alliumBranch: "allium/setup-test",
				alliumSkillsPath: "/tmp/fake-skills",
				autoConfirm: true,
			});

			// Write state by requesting immediate shutdown after setup completes.
			const shutdownSignal = new ShutdownSignal();
			setTimeout(() => shutdownSignal.request(), 50);
			await expect(runEvolution(config, shutdownSignal)).rejects.toThrow("Graceful shutdown requested");

			const result = await setupEvolution(config);
			expect(result.isResume).toBe(true);
			expect(result.resumeInfo.mode).toBe("state-file");
		});
	});
});

describe("setupEvolution – allium-branch auto-detect", () => {
	let tmpDir: string;
	let repoPath: string;

	beforeAll(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "allium-setup-allium-"));
		repoPath = join(tmpDir, "repo");
		await cp(FIXTURE_REPO, repoPath, { recursive: true });
		await execAsync('git config user.email "test@allium-evolve.dev"', { cwd: repoPath });
		await execAsync('git config user.name "Test Author"', { cwd: repoPath });
	}, 30_000);

	afterAll(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	describe("INT-SETUP-006: Auto-resume from allium branch seeds state correctly", () => {
		it("should seed state from allium branch when no state file exists", async () => {
			const stateFilePath = join(tmpDir, "nonexistent-state.json");
			const { stdout: rootCommitRaw } = await execAsync("git rev-list --max-parents=0 HEAD", {
				cwd: repoPath,
			});
			// The fixture repo must have a single root commit for this test to be deterministic.
			const rootCommitLines = rootCommitRaw.trim().split("\n").filter(Boolean);
			if (rootCommitLines.length !== 1) {
				throw new Error(`INT-SETUP-006: Expected exactly one root commit, found ${rootCommitLines.length}. Check the fixture repo.`);
			}
			const rootCommit = rootCommitLines[0]!;
			await execAsync("git checkout -b allium/evolution", { cwd: repoPath });
			await writeFile(join(repoPath, "spec.allium"), "entity User {}");
			await writeFile(join(repoPath, "allium-changelog.md"), "# Changelog\n");
			const body = `allium: init\n\n${formatOriginalLine(rootCommit, "init")}\n`;
			await execAsync(
				`git add spec.allium allium-changelog.md && git commit -m "${body.replace(/"/g, '\\"')}"`,
				{ cwd: repoPath },
			);
			await execAsync("git checkout main", { cwd: repoPath });

			const config = defaultConfig({
				repoPath,
				targetRef: "main",
				parallelBranches: false,
				stateFile: stateFilePath,
				alliumBranch: "allium/evolution",
				alliumSkillsPath: "/tmp/fake-skills",
			});

			const result = await setupEvolution(config);
			expect(result.isResume).toBe(true);
			expect(result.resumeInfo.mode).toBe("allium-branch");
			const state = result.stateTracker.getState();
			expect(Object.keys(state.shaMap).length).toBeGreaterThan(0);
		});
	});

	describe("INT-SETUP-007: autoConfirm bypasses prompt", () => {
		it("should not hang when autoConfirm is true", async () => {
			const { ShutdownSignal } = await import("../../src/shutdown.js");
			const stateFilePath = join(tmpDir, "state-autoconfirm.json");
			const config = defaultConfig({
				repoPath,
				targetRef: "main",
				parallelBranches: false,
				stateFile: stateFilePath,
				alliumBranch: "allium/evolution",
				alliumSkillsPath: "/tmp/fake-skills",
				autoConfirm: true,
			});

			const shutdownSignal = new ShutdownSignal();
			// Request shutdown after a short delay to allow runEvolution's internal
			// setupEvolution to complete before the signal arrives.
			setTimeout(() => shutdownSignal.request(), 50);

			await expect(runEvolution(config, shutdownSignal)).rejects.toThrow("Graceful shutdown requested");
		});
	});

	describe("INT-SETUP-008: allium branch with no Original: tags produces clear error", () => {
		it("should throw when allium branch has no Original: tags", async () => {
			const stateFilePath = join(tmpDir, "no-original-state.json");
			await execAsync("git checkout -B allium/no-original 2>/dev/null || git checkout -b allium/no-original", {
				cwd: repoPath,
			});
			await writeFile(join(repoPath, "spec.allium"), "entity User {}");
			await writeFile(join(repoPath, "allium-changelog.md"), "");
			await execAsync("git add spec.allium allium-changelog.md && git commit -m 'allium: init'", {
				cwd: repoPath,
			});
			await execAsync("git checkout main", { cwd: repoPath });

			const config = defaultConfig({
				repoPath,
				targetRef: "main",
				stateFile: stateFilePath,
				alliumBranch: "allium/no-original",
			});

			await expect(setupEvolution(config)).rejects.toThrow("No Original: tag found");
		});
	});

	describe("INT-SETUP-009: Corrupt state file falls through to allium-branch detection", () => {
		let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

		beforeAll(() => {
			consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		});

		afterEach(() => {
			consoleErrorSpy.mockRestore();
		});

		it("should fall back to allium branch when state file is corrupt", async () => {
			const stateFilePath = join(tmpDir, "corrupt-state.json");
			await writeFile(stateFilePath, "{CORRUPT");
			const { stdout: rootCommit } = await execAsync("git rev-list --max-parents=0 HEAD", {
				cwd: repoPath,
			});
			await execAsync("git checkout -B allium/fallback 2>/dev/null || git checkout -b allium/fallback", {
				cwd: repoPath,
			});
			await writeFile(join(repoPath, "spec.allium"), "entity User {}");
			await writeFile(join(repoPath, "allium-changelog.md"), "");
			const body = `allium: init\n\n${formatOriginalLine(rootCommit.trim().split("\n")[0]!, "init")}\n`;
			await execAsync(
				`git add spec.allium allium-changelog.md && git commit -m "${body.replace(/"/g, '\\"')}"`,
				{ cwd: repoPath },
			);
			await execAsync("git checkout main", { cwd: repoPath });

			const config = defaultConfig({
				repoPath,
				targetRef: "main",
				stateFile: stateFilePath,
				alliumBranch: "allium/fallback",
			});

			const result = await setupEvolution(config);
			expect(result.resumeInfo.mode).toBe("allium-branch");
			expect(result.isResume).toBe(true);
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining("exists but is unreadable"),
			);
		});
	});

	describe("INT-SETUP-010: State file referencing commits not in DAG throws", () => {
		it("should throw when state file has invalid rootCommit", async () => {
			const stateFilePath = join(tmpDir, "bad-state.json");
			const badState = {
				version: 1,
				repoPath,
				targetRef: "main",
				rootCommit: "a".repeat(40),
				config: {},
				segments: [],
				segmentProgress: {},
				shaMap: {},
				completedMerges: [],
				alliumBranchHead: "",
				totalCostUsd: 0,
				totalSteps: 0,
				reconciliations: [],
				lastReconciliationStep: 0,
				lastReconciliationSha: undefined,
				cumulativeDiffTokensSinceLastReconciliation: 0,
			};
			await writeFile(stateFilePath, JSON.stringify(badState));

			const config = defaultConfig({
				repoPath,
				targetRef: "main",
				stateFile: stateFilePath,
				alliumBranch: "allium/evolution",
			});

			await expect(setupEvolution(config)).rejects.toThrow(
				"State file references commits not in the current DAG",
			);
		});
	});

	describe("INT-SETUP-011: Allium branch startAfterSha not in HEAD ancestry throws", () => {
		it("should throw when allium branch references a commit not in the current HEAD history", async () => {
			const stateFilePath = join(tmpDir, "orphan-state.json");
			await execAsync("git checkout --orphan orphan-branch", { cwd: repoPath });
			await writeFile(join(repoPath, "f"), "x");
			await execAsync("git add f && git commit -m 'orphan'", { cwd: repoPath });
			const { stdout: orphanSha } = await execAsync("git rev-parse HEAD", { cwd: repoPath });
			await execAsync("git checkout main", { cwd: repoPath });
			await execAsync("git branch -D orphan-branch 2>/dev/null || true", { cwd: repoPath });

			await execAsync("git checkout -B allium/orphan 2>/dev/null || git checkout -b allium/orphan", {
				cwd: repoPath,
			});
			await writeFile(join(repoPath, "spec.allium"), "entity User {}");
			await writeFile(join(repoPath, "allium-changelog.md"), "");
			const body = `allium: init\n\n${formatOriginalLine(orphanSha.trim(), "orphan")}\n`;
			await execAsync(
				`git add spec.allium allium-changelog.md && git commit -m "${body.replace(/"/g, '\\"')}"`,
				{ cwd: repoPath },
			);
			await execAsync("git checkout main", { cwd: repoPath });

			const config = defaultConfig({
				repoPath,
				targetRef: "main",
				stateFile: stateFilePath,
				alliumBranch: "allium/orphan",
			});

			await expect(setupEvolution(config)).rejects.toThrow(/not in the current DAG|Restore the missing commits/);
		});
	});
});
