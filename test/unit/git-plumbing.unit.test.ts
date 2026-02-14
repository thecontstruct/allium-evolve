import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CreateAlliumCommitOpts, createAlliumCommit, updateRef } from "../../src/git/plumbing.js";
import { exec } from "../../src/utils/exec.js";

async function initRepo(dir: string): Promise<string> {
	await exec("git init", { cwd: dir });
	await exec('git config user.email "test@test.com"', { cwd: dir });
	await exec('git config user.name "Test"', { cwd: dir });
	await exec("git checkout -b main", { cwd: dir });
	// Create an initial commit with a file
	await exec('echo "hello" > file.txt', { cwd: dir });
	await exec("git add file.txt", { cwd: dir });
	await exec('git commit -m "initial commit"', { cwd: dir });
	const { stdout } = await exec("git rev-parse HEAD", { cwd: dir });
	return stdout.trim();
}

describe("git/plumbing.ts", () => {
	let tmpDir: string;
	let initialSha: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "allium-plumbing-"));
		initialSha = await initRepo(tmpDir);
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	function baseOpts(overrides: Partial<CreateAlliumCommitOpts> = {}): CreateAlliumCommitOpts {
		return {
			repoPath: tmpDir,
			originalSha: initialSha,
			parentShas: [initialSha],
			specContent: "domain: TestDomain\nversion: 1",
			changelogContent: "# Changelog\n\n- Initial spec",
			commitMessage: "allium: initial spec",
			...overrides,
		};
	}

	describe("UNIT-042: createAlliumCommit creates a valid commit", () => {
		it("should return a valid commit SHA", async () => {
			const sha = await createAlliumCommit(baseOpts());
			expect(sha).toMatch(/^[0-9a-f]{40}$/);
		});

		it("should create a commit with the correct message", async () => {
			const sha = await createAlliumCommit(baseOpts());
			const { stdout } = await exec(`git cat-file -p ${sha}`, { cwd: tmpDir });
			expect(stdout).toContain("allium: initial spec");
		});

		it("should have the correct parent", async () => {
			const sha = await createAlliumCommit(baseOpts());
			const { stdout } = await exec(`git cat-file -p ${sha}`, { cwd: tmpDir });
			expect(stdout).toContain(`parent ${initialSha}`);
		});

		it("should contain spec.allium with correct content", async () => {
			const sha = await createAlliumCommit(baseOpts());
			const { stdout } = await exec(`git show ${sha}:spec.allium`, { cwd: tmpDir });
			expect(stdout).toBe("domain: TestDomain\nversion: 1");
		});

		it("should contain allium-changelog.md with correct content", async () => {
			const sha = await createAlliumCommit(baseOpts());
			const { stdout } = await exec(`git show ${sha}:allium-changelog.md`, { cwd: tmpDir });
			expect(stdout).toBe("# Changelog\n\n- Initial spec");
		});
	});

	describe("UNIT-043: Commit tree contains original files plus allium files", () => {
		it("should include file.txt from the original commit", async () => {
			const sha = await createAlliumCommit(baseOpts());
			const { stdout } = await exec(`git show ${sha}:file.txt`, { cwd: tmpDir });
			expect(stdout.trim()).toBe("hello");
		});

		it("should list all three files in the tree", async () => {
			const sha = await createAlliumCommit(baseOpts());
			const { stdout } = await exec(`git ls-tree --name-only ${sha}`, { cwd: tmpDir });
			const files = stdout.trim().split("\n").sort();
			expect(files).toEqual(["allium-changelog.md", "file.txt", "spec.allium"]);
		});
	});

	describe("UNIT-044: Merge commit with two parents", () => {
		it("should create a commit with two parents", async () => {
			// Create a second branch commit to use as second parent
			await exec('echo "branch" > branch.txt', { cwd: tmpDir });
			await exec("git add branch.txt", { cwd: tmpDir });
			await exec('git commit -m "branch commit"', { cwd: tmpDir });
			const { stdout: secondSha } = await exec("git rev-parse HEAD", { cwd: tmpDir });

			const sha = await createAlliumCommit(baseOpts({ parentShas: [initialSha, secondSha.trim()] }));

			const { stdout: commitObj } = await exec(`git cat-file -p ${sha}`, { cwd: tmpDir });
			const parentLines = commitObj.split("\n").filter((line: string) => line.startsWith("parent "));

			expect(parentLines).toHaveLength(2);
			expect(parentLines[0]).toContain(initialSha);
			expect(parentLines[1]).toContain(secondSha.trim());
		});
	});

	describe("UNIT-045: Temp index file cleanup", () => {
		it("should not leave any index.allium.* files after success", async () => {
			await createAlliumCommit(baseOpts());
			const gitDir = join(tmpDir, ".git");
			const files = await readdir(gitDir);
			const tempIndexFiles = files.filter((f) => f.startsWith("index.allium."));
			expect(tempIndexFiles).toHaveLength(0);
		});

		it("should clean up temp index even when the commit fails", async () => {
			try {
				await createAlliumCommit(baseOpts({ originalSha: "0000000000000000000000000000000000000000" }));
			} catch {
				// expected to fail
			}

			const gitDir = join(tmpDir, ".git");
			const files = await readdir(gitDir);
			const tempIndexFiles = files.filter((f) => f.startsWith("index.allium."));
			expect(tempIndexFiles).toHaveLength(0);
		});
	});

	describe("UNIT-046: updateRef correctly moves a branch ref", () => {
		it("should update a ref to point to the given SHA", async () => {
			const commitSha = await createAlliumCommit(baseOpts());
			await updateRef(tmpDir, "refs/heads/allium", commitSha);

			const { stdout } = await exec("git rev-parse refs/heads/allium", { cwd: tmpDir });
			expect(stdout.trim()).toBe(commitSha);
		});

		it("should update an existing ref to a new SHA", async () => {
			const first = await createAlliumCommit(baseOpts());
			await updateRef(tmpDir, "refs/heads/allium", first);

			const second = await createAlliumCommit(
				baseOpts({
					parentShas: [first],
					specContent: "domain: TestDomain\nversion: 2",
					commitMessage: "allium: update spec",
				}),
			);
			await updateRef(tmpDir, "refs/heads/allium", second);

			const { stdout } = await exec("git rev-parse refs/heads/allium", { cwd: tmpDir });
			expect(stdout.trim()).toBe(second);
		});
	});

	describe("UNIT-047: Concurrent createAlliumCommit calls", () => {
		it("should produce three independent valid commits without corruption", async () => {
			const results = await Promise.all([
				createAlliumCommit(
					baseOpts({
						specContent: "domain: A\nversion: 1",
						commitMessage: "allium: segment A",
						segmentId: "seg-a",
					}),
				),
				createAlliumCommit(
					baseOpts({
						specContent: "domain: B\nversion: 1",
						commitMessage: "allium: segment B",
						segmentId: "seg-b",
					}),
				),
				createAlliumCommit(
					baseOpts({
						specContent: "domain: C\nversion: 1",
						commitMessage: "allium: segment C",
						segmentId: "seg-c",
					}),
				),
			]);

			// All three should be distinct valid SHAs
			expect(new Set(results).size).toBe(3);
			for (const sha of results) {
				expect(sha).toMatch(/^[0-9a-f]{40}$/);
			}

			// Verify each commit has its own correct spec content
			const contents = await Promise.all(
				results.map(async (sha) => {
					const { stdout } = await exec(`git show ${sha}:spec.allium`, { cwd: tmpDir });
					return stdout;
				}),
			);

			expect(contents.sort()).toEqual(["domain: A\nversion: 1", "domain: B\nversion: 1", "domain: C\nversion: 1"]);
		});

		it("should not leave any temp index files behind", async () => {
			await Promise.all([
				createAlliumCommit(baseOpts({ segmentId: "seg-1" })),
				createAlliumCommit(baseOpts({ segmentId: "seg-2" })),
				createAlliumCommit(baseOpts({ segmentId: "seg-3" })),
			]);

			const gitDir = join(tmpDir, ".git");
			const files = await readdir(gitDir);
			const tempIndexFiles = files.filter((f) => f.startsWith("index.allium."));
			expect(tempIndexFiles).toHaveLength(0);
		});
	});
});
