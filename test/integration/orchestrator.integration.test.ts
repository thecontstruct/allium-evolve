import { exec as cpExec } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
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

describe("Orchestrator – sequential mode", () => {
	let tmpDir: string;
	let repoPath: string;
	let stateFilePath: string;

	beforeAll(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "allium-orch-seq-"));
		repoPath = join(tmpDir, "repo");
		stateFilePath = join(tmpDir, "state.json");

		// Copy the fixture repo (preserving .git)
		await cp(FIXTURE_REPO, repoPath, { recursive: true });

		// Configure git identity in the copy so commit-tree works
		await execAsync('git config user.email "test@allium-evolve.dev"', { cwd: repoPath });
		await execAsync('git config user.name "Test Author"', { cwd: repoPath });

		// Dynamic imports after mock is set up
		const { defaultConfig } = await import("../../src/config.js");
		const { runEvolution } = await import("../../src/evolution/orchestrator.js");

		const config = defaultConfig({
			repoPath,
			targetRef: "main",
			parallelBranches: false,
			stateFile: stateFilePath,
			alliumBranch: "allium/evolution",
			alliumSkillsPath: "/tmp/fake-skills",
		});

		await runEvolution(config);
	}, 60_000);

	afterAll(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	describe("INT-001: Full sequential run creates allium branch with correct commit count", () => {
		it("should create allium commits for all 15 original commits (tracked in state file)", async () => {
			const raw = await readFile(stateFilePath, "utf-8");
			const state = JSON.parse(raw);
			// shaMap has one entry per original commit → allium commit mapping
			expect(Object.keys(state.shaMap).length).toBe(15);
		});

		it("should have 10 reachable commits from branch tip (dead-end is last segment in sequential mode)", async () => {
			// In sequential mode, all segments update the allium branch ref.
			// The dead-end segment runs last in topological order, so its tip
			// becomes the branch head. Only 10 commits are reachable from there:
			// dead-end-0(2) + trunk-1(3) + trunk-0(3) + branch-1(2) = 10
			const { stdout } = await execAsync("git rev-list --count refs/heads/allium/evolution", { cwd: repoPath });
			expect(Number.parseInt(stdout.trim(), 10)).toBe(10);
		});
	});

	describe("INT-002: Allium branch tip exists and is reachable", () => {
		it("should resolve allium/evolution to a valid commit SHA", async () => {
			const { stdout } = await execAsync("git rev-parse refs/heads/allium/evolution", { cwd: repoPath });
			const sha = stdout.trim();
			expect(sha).toMatch(/^[0-9a-f]{40}$/);
		});

		it("should be reachable from the allium branch HEAD", async () => {
			const { stdout } = await execAsync("git cat-file -t refs/heads/allium/evolution", { cwd: repoPath });
			expect(stdout.trim()).toBe("commit");
		});
	});

	describe("INT-003: Merge commits on allium branch have two parents", () => {
		it("should have at least 1 merge commit reachable from branch tip", async () => {
			// In sequential mode the branch tip is the dead-end segment's tip.
			// From there, only the M1 merge allium commit is reachable (not M2).
			const { stdout } = await execAsync('git log refs/heads/allium/evolution --format="%H %P"', { cwd: repoPath });
			const lines = stdout.trim().split("\n").filter(Boolean);
			const mergeCommits = lines.filter((line) => {
				const parts = line.split(" ");
				return parts.length >= 3; // sha + 2+ parents
			});
			expect(mergeCommits.length).toBeGreaterThanOrEqual(1);
		});

		it("should have 2 total merge commits across all allium objects (verified via state)", async () => {
			const raw = await readFile(stateFilePath, "utf-8");
			const state = JSON.parse(raw);
			expect(state.completedMerges.length).toBe(2);

			// Verify each recorded merge commit actually has 2 parents in git
			for (const merge of state.completedMerges) {
				const { stdout } = await execAsync(`git cat-file -p ${merge.alliumSha}`, { cwd: repoPath });
				const parentLines = stdout.split("\n").filter((line: string) => line.startsWith("parent "));
				expect(parentLines).toHaveLength(2);
			}
		});

		it("each reachable commit should have at most 2 parents", async () => {
			const { stdout } = await execAsync('git log refs/heads/allium/evolution --format="%H %P"', { cwd: repoPath });
			const lines = stdout.trim().split("\n").filter(Boolean);
			for (const line of lines) {
				const parts = line.split(" ");
				const parentCount = parts.length - 1;
				expect(parentCount).toBeLessThanOrEqual(2);
			}
		});
	});

	describe("INT-004: State file is created with all segments marked complete", () => {
		it("should create the state file", async () => {
			const raw = await readFile(stateFilePath, "utf-8");
			const state = JSON.parse(raw);
			expect(state.version).toBe(1);
		});

		it("should have all segments marked complete", async () => {
			const raw = await readFile(stateFilePath, "utf-8");
			const state = JSON.parse(raw);
			const progressEntries = Object.values(state.segmentProgress) as Array<{ status: string }>;
			expect(progressEntries.length).toBeGreaterThan(0);
			for (const entry of progressEntries) {
				expect(entry.status).toBe("complete");
			}
		});
	});

	describe("INT-005: State file has correct total step count", () => {
		it("should have totalSteps equal to 15 (one per original commit)", async () => {
			const raw = await readFile(stateFilePath, "utf-8");
			const state = JSON.parse(raw);
			expect(state.totalSteps).toBe(15);
		});

		it("should have totalCostUsd matching step count * 0.01", async () => {
			const raw = await readFile(stateFilePath, "utf-8");
			const state = JSON.parse(raw);
			expect(state.totalCostUsd).toBeCloseTo(0.15, 6);
		});
	});
});
