import { resolve } from "node:path";
import { assembleContext } from "../../src/claude/context.js";
import type { CommitNode } from "../../src/dag/types.js";
import { advance, createWindow } from "../../src/evolution/window.js";
import { parseGitLog } from "../../src/git/log.js";

const FIXTURE_REPO = resolve(import.meta.dirname, "..", "fixtures", "repo");

describe("claude/context", () => {
	let dag: Map<string, CommitNode>;
	let trunkShas: string[];

	beforeAll(async () => {
		dag = await parseGitLog(FIXTURE_REPO);

		// Build the trunk in chronological order from the fixture repo
		// A -> B -> C -> M1 -> D -> E -> M2 -> F
		const { exec } = await import("../../src/utils/exec.js");
		const { stdout } = await exec("git log --first-parent --reverse --format=%H", {
			cwd: FIXTURE_REPO,
		});
		trunkShas = stdout.trim().split("\n");
	});

	describe("UNIT-048: assembleContext formats context commits correctly", () => {
		it("formats context SHAs as headers with short SHA and message, no diffs", async () => {
			// windowSize=5, processDepth=1 → last 1 is full diff, rest are context
			let state = createWindow(5, 1);
			for (const sha of trunkShas.slice(0, 4)) {
				state = advance(state, sha);
			}
			// 4 commits, processDepth=1 → 3 context, 1 full diff

			const result = await assembleContext({
				windowState: state,
				dag,
				repoPath: FIXTURE_REPO,
				prevSpec: "",
			});

			const lines = result.contextCommits.split("\n");
			expect(lines.length).toBe(3);

			for (const line of lines) {
				expect(line).toMatch(/^### [a-f0-9]{8} — .+/);
			}

			// Context commits should NOT contain diff blocks
			expect(result.contextCommits).not.toContain("```diff");
		});
	});

	describe("UNIT-049: assembleContext includes full diffs for processDepth tail commits", () => {
		it("includes fenced diff blocks for full-diff SHAs", async () => {
			// windowSize=5, processDepth=2 → last 2 get full diffs
			let state = createWindow(5, 2);
			for (const sha of trunkShas.slice(0, 4)) {
				state = advance(state, sha);
			}

			const result = await assembleContext({
				windowState: state,
				dag,
				repoPath: FIXTURE_REPO,
				prevSpec: "",
			});

			// Should contain exactly 2 diff fenced blocks
			const diffBlocks = result.fullDiffs.match(/```diff/g);
			expect(diffBlocks).not.toBeNull();
			expect(diffBlocks!.length).toBe(2);

			// Each block should have header + diff content
			for (const sha of trunkShas.slice(2, 4)) {
				expect(result.fullDiffs).toContain(sha.slice(0, 8));
			}

			// Diffs should contain actual git diff content
			expect(result.fullDiffs).toMatch(/diff --git|---|\+\+\+/);
		});
	});

	describe("UNIT-050: assembleContext with prevSpec passes it through", () => {
		it("returns the prevSpec unchanged in the result", async () => {
			const prevSpec = "# Previous Specification\n\nSome domain model description.";

			let state = createWindow(5, 1);
			state = advance(state, trunkShas[0]!);

			const result = await assembleContext({
				windowState: state,
				dag,
				repoPath: FIXTURE_REPO,
				prevSpec,
			});

			expect(result.prevSpec).toBe(prevSpec);
		});
	});

	describe("UNIT-051: totalDiffTokens is a positive number for non-empty diffs", () => {
		it("returns a positive token count when diffs are present", async () => {
			let state = createWindow(5, 2);
			for (const sha of trunkShas.slice(0, 3)) {
				state = advance(state, sha);
			}

			const result = await assembleContext({
				windowState: state,
				dag,
				repoPath: FIXTURE_REPO,
				prevSpec: "",
			});

			expect(result.totalDiffTokens).toBeGreaterThan(0);
			expect(typeof result.totalDiffTokens).toBe("number");
		});
	});

	describe("UNIT-052: assembleContext handles single-commit window", () => {
		it("produces no context commits when there is only one commit in the window", async () => {
			// windowSize=5, processDepth=1, single commit → all in fullDiff, none in context
			let state = createWindow(5, 1);
			state = advance(state, trunkShas[0]!);

			const result = await assembleContext({
				windowState: state,
				dag,
				repoPath: FIXTURE_REPO,
				prevSpec: "",
			});

			expect(result.contextCommits).toBe("");
			// Should still have a full diff for the single commit
			expect(result.fullDiffs).toContain("```diff");
			expect(result.fullDiffs).toContain(trunkShas[0]!.slice(0, 8));
		});
	});
});
