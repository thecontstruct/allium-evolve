import { exec as cpExec } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const execAsync = promisify(cpExec);

vi.mock("../../src/claude/runner.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		invokeClaudeForStep: vi.fn(async () => {
			// callCount is scoped inside the factory so retries start from a clean state.
			const callId = Math.random().toString(36).slice(2);
			return {
				spec: `spec-v${callId}`,
				changelog: `changelog entry ${callId}`,
				commitMessage: `evolve step ${callId}`,
				sessionId: `session-${callId}`,
				costUsd: 0.01,
			};
		}),
	};
});

const FIXTURE_REPO = resolve(import.meta.dirname, "../fixtures/repo");

describe("Orchestrator – sequential mode", () => {
	let tmpDir: string;
	let repoPath: string;
	let stateFilePath: string;
	let parsedState: Record<string, unknown>;

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
			autoConfirm: true,
		});

		await runEvolution(config);

		// Parse state file once so individual tests don't each re-read from disk.
		parsedState = JSON.parse(await readFile(stateFilePath, "utf-8")) as Record<string, unknown>;
	}, 60_000);

	afterAll(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	describe("INT-001: Full sequential run creates allium branch with correct commit count", () => {
		it("should create allium commits for all original commits (tracked in state file)", () => {
			// shaMap has one entry per original commit → allium commit mapping
			expect(Object.keys(parsedState.shaMap as Record<string, string>).length).toBe(28);
		});

		it("should have reachable commits from the allium branch tip", async () => {
			// The allium branch ref is updated by the last trunk segment (trunk segments write
			// to refs/heads/allium/evolution). Branch (dead-end) segments do not update the ref
			// directly but their commits become reachable via merge commit parents.
			const { stdout } = await execAsync("git rev-list --count refs/heads/allium/evolution", { cwd: repoPath });
			expect(Number.parseInt(stdout.trim(), 10)).toBeGreaterThan(10);
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
			// In sequential mode, the allium branch ref points to the trunk tip.
			// Merge commits are reachable through the branch history.
			const { stdout } = await execAsync('git log refs/heads/allium/evolution --format="%H %P"', { cwd: repoPath });
			const lines = stdout.trim().split("\n").filter(Boolean);
			const mergeCommits = lines.filter((line) => {
				const parts = line.split(" ");
				return parts.length >= 3; // sha + 2+ parents
			});
			expect(mergeCommits.length).toBeGreaterThanOrEqual(1);
		});

		it("should have 2 total merge commits across all allium objects (verified via state)", async () => {
			const completedMerges = parsedState.completedMerges as Array<{ alliumSha: string }>;
			expect(completedMerges.length).toBe(2);

			// Verify each recorded merge commit actually has 2 parents in git
			for (const merge of completedMerges) {
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
		it("should create the state file", () => {
			expect(parsedState.version).toBe(1);
		});

		it("should have all segments marked complete", () => {
			const progressEntries = Object.values(parsedState.segmentProgress as Record<string, { status: string }>);
			expect(progressEntries.length).toBeGreaterThan(0);
			for (const entry of progressEntries) {
				expect(entry.status).toBe("complete");
			}
		});
	});

	describe("INT-005: State file has correct total step count", () => {
		it("should have totalSteps equal to 28 (one per original commit)", () => {
			expect(parsedState.totalSteps).toBe(28);
		});

		it("should have totalCostUsd matching step count * 0.01", () => {
			expect(parsedState.totalCostUsd as number).toBeCloseTo(0.28, 6);
		});
	});
});
