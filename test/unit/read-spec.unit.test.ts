import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { readChangelogFromCommit, readSpecFromCommit } from "../../src/git/read-spec.js";

const execAsync = promisify(exec);

describe("read-spec", () => {
	it("reads spec.allium from commit", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "read-spec-"));
		await execAsync("git init", { cwd: tmp });
		await execAsync('git config user.email "test@test"', { cwd: tmp });
		await execAsync('git config user.name "Test"', { cwd: tmp });
		await writeFile(join(tmp, "spec.allium"), "entity User { name: String }");
		await writeFile(join(tmp, "allium-changelog.md"), "# Changelog\n");
		await execAsync("git add spec.allium allium-changelog.md && git commit -m 'allium: init'", { cwd: tmp });
		const { stdout: sha } = await execAsync("git rev-parse HEAD", { cwd: tmp });
		const spec = await readSpecFromCommit(tmp, sha.trim());
		expect(spec).toContain("entity User");
	});

	it("reads allium-changelog.md from commit", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "read-spec-"));
		await execAsync("git init", { cwd: tmp });
		await execAsync('git config user.email "test@test"', { cwd: tmp });
		await execAsync('git config user.name "Test"', { cwd: tmp });
		await writeFile(join(tmp, "spec.allium"), "entity User {}");
		await writeFile(join(tmp, "allium-changelog.md"), "# Changelog\n\n## abc123\n\nAdded User");
		await execAsync("git add spec.allium allium-changelog.md && git commit -m 'allium: init'", { cwd: tmp });
		const { stdout: sha } = await execAsync("git rev-parse HEAD", { cwd: tmp });
		const changelog = await readChangelogFromCommit(tmp, sha.trim());
		expect(changelog).toContain("# Changelog");
		expect(changelog).toContain("Added User");
	});

	it("returns empty string for missing changelog", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "read-spec-"));
		await execAsync("git init", { cwd: tmp });
		await execAsync('git config user.email "test@test"', { cwd: tmp });
		await execAsync('git config user.name "Test"', { cwd: tmp });
		await writeFile(join(tmp, "spec.allium"), "entity User {}");
		await execAsync("git add spec.allium && git commit -m 'allium: init'", { cwd: tmp });
		const { stdout: sha } = await execAsync("git rev-parse HEAD", { cwd: tmp });
		const changelog = await readChangelogFromCommit(tmp, sha.trim());
		expect(changelog).toBe("");
	});
});
