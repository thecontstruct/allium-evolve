import { join } from "node:path";
import { getDiff, getDiffstat, getEmptyTreeSha } from "../../src/git/diff.js";

const FIXTURE_REPO = join(import.meta.dirname, "..", "fixtures", "repo");

describe("git/diff", () => {
	// Resolve SHAs from the fixture repo at test time
	let firstSha: string;
	let secondSha: string;

	beforeAll(async () => {
		const { exec } = await import("../../src/utils/exec.js");

		// Get the first two commits (oldest first)
		const { stdout } = await exec("git log --reverse --format=%H", {
			cwd: FIXTURE_REPO,
		});
		const shas = stdout.trim().split("\n");
		firstSha = shas[0]!;
		secondSha = shas[1]!;
	});

	describe("UNIT-014: getDiff returns non-empty diff between two commits", () => {
		it("returns a diff string containing file changes", async () => {
			const diff = await getDiff(FIXTURE_REPO, firstSha, secondSha);
			expect(diff).toBeTruthy();
			expect(diff.length).toBeGreaterThan(0);
			// A git diff should contain typical diff markers
			expect(diff).toMatch(/diff --git|---|\+\+\+/);
		});
	});

	describe("UNIT-015: getDiff handles initial commit (null fromSha)", () => {
		it("returns a diff for the initial commit when fromSha is null", async () => {
			const diff = await getDiff(FIXTURE_REPO, null, firstSha);
			expect(diff).toBeTruthy();
			expect(diff.length).toBeGreaterThan(0);
		});

		it("getEmptyTreeSha returns the well-known empty tree SHA", () => {
			expect(getEmptyTreeSha()).toBe("4b825dc642cb6eb9a060e54bf899d15f3f762975");
		});
	});

	describe("UNIT-016: getDiffstat returns file change summary", () => {
		it("returns a stat summary with file names and change counts", async () => {
			const stat = await getDiffstat(FIXTURE_REPO, firstSha, secondSha);
			expect(stat).toBeTruthy();
			// diffstat typically contains file names and +/- indicators
			expect(stat).toMatch(/\d+ file/);
		});
	});
});
