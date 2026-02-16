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

describe("Orchestrator – parallel mode", () => {
	let tmpDir: string;
	let repoPath: string;
	let stateFilePath: string;

	beforeAll(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "allium-orch-par-"));
		repoPath = join(tmpDir, "repo");
		stateFilePath = join(tmpDir, "state.json");

		await cp(FIXTURE_REPO, repoPath, { recursive: true });

		await execAsync('git config user.email "test@allium-evolve.dev"', { cwd: repoPath });
		await execAsync('git config user.name "Test Author"', { cwd: repoPath });

		const { defaultConfig } = await import("../../src/config.js");
		const { runEvolution } = await import("../../src/evolution/orchestrator.js");

		const config = defaultConfig({
			repoPath,
			targetRef: "main",
			parallelBranches: true,
			maxConcurrency: 2,
			stateFile: stateFilePath,
			alliumBranch: "allium/evolution",
			alliumSkillsPath: "/tmp/fake-skills",
		});

		await runEvolution(config);
	}, 60_000);

	afterAll(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	describe("INT-006: Full parallel run creates same allium branch structure as sequential", () => {
		it("should have 13 reachable commits on allium/evolution", async () => {
			const { stdout } = await execAsync("git rev-list --count refs/heads/allium/evolution", { cwd: repoPath });
			expect(Number.parseInt(stdout.trim(), 10)).toBe(13);
		});

		it("should have exactly 2 merge commits on allium branch", async () => {
			const { stdout } = await execAsync('git log refs/heads/allium/evolution --format="%H %P"', { cwd: repoPath });
			const lines = stdout.trim().split("\n").filter(Boolean);
			const mergeCommits = lines.filter((line) => {
				const parts = line.split(" ");
				return parts.length >= 3;
			});
			expect(mergeCommits.length).toBe(2);
		});

		it("should have all segments marked complete in state file", async () => {
			const raw = await readFile(stateFilePath, "utf-8");
			const state = JSON.parse(raw);
			const progressEntries = Object.values(state.segmentProgress) as Array<{ status: string }>;
			for (const entry of progressEntries) {
				expect(entry.status).toBe("complete");
			}
		});

		it("should have 30 total steps", async () => {
			const raw = await readFile(stateFilePath, "utf-8");
			const state = JSON.parse(raw);
			expect(state.totalSteps).toBe(30);
		});
	});

	describe("INT-007: Per-segment refs exist in refs/allium/segments/", () => {
		it("should create refs for non-trunk segments under refs/allium/segments/", async () => {
			const { stdout } = await execAsync("git for-each-ref --format='%(refname)' refs/allium/segments/", {
				cwd: repoPath,
			});
			const refs = stdout.trim().split("\n").filter(Boolean);
			// There should be refs for branch-0, branch-1, and dead-end-0
			expect(refs.length).toBe(3);
		});

		it("each segment ref should point to a valid commit", async () => {
			const { stdout } = await execAsync("git for-each-ref --format='%(objecttype)' refs/allium/segments/", {
				cwd: repoPath,
			});
			const types = stdout.trim().split("\n").filter(Boolean);
			for (const t of types) {
				expect(t).toBe("commit");
			}
		});
	});
});
