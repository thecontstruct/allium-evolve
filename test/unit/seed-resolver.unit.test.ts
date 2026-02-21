import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildShaMapFromAlliumBranch, resolveSeedAlliumSha } from "../../src/evolution/seed-resolver.js";
import { formatOriginalLine } from "../../src/git/commit-metadata.js";

const execAsync = promisify(exec);

async function createAlliumBranch(tmp: string): Promise<{ commitA: string; commitB: string }> {
	await execAsync("git init", { cwd: tmp });
	await execAsync('git config user.email "test@test"', { cwd: tmp });
	await execAsync('git config user.name "Test"', { cwd: tmp });
	await writeFile(join(tmp, "spec.allium"), "entity User {}");
	await writeFile(join(tmp, "allium-changelog.md"), "# Changelog\n");
	await execAsync("git add spec.allium allium-changelog.md && git commit -m 'allium: init'", { cwd: tmp });
	const { stdout: shaA } = await execAsync("git rev-parse HEAD", { cwd: tmp });
	await writeFile(join(tmp, "spec.allium"), "entity User { name: String }");
	await execAsync("git add spec.allium && git commit -m 'allium: add name'", { cwd: tmp });
	const { stdout: shaB } = await execAsync("git rev-parse HEAD", { cwd: tmp });
	await execAsync("git checkout -b allium/evolution", { cwd: tmp });
	await execAsync(`git reset --hard ${shaA.trim()}`, { cwd: tmp });
	await execAsync("git commit --allow-empty -m 'allium: empty'", { cwd: tmp });
	const { stdout: alliumSha } = await execAsync("git rev-parse HEAD", { cwd: tmp });
	const origA = shaA.trim();
	const body = `allium: init\n\n${formatOriginalLine(origA, "feat: init")}\n`;
	await execAsync(`git commit --amend -m "${body.replace(/"/g, '\\"')}"`, { cwd: tmp });
	const { stdout: alliumA } = await execAsync("git rev-parse HEAD", { cwd: tmp });
	await execAsync(`git cherry-pick ${shaB.trim()}`, { cwd: tmp });
	const { stdout: alliumB } = await execAsync("git rev-parse HEAD", { cwd: tmp });
	await execAsync("git checkout -", { cwd: tmp });
	return { commitA: alliumA.trim(), commitB: alliumB.trim() };
}

describe("seed-resolver", () => {
	it("resolveSeedAlliumSha finds commit by Original: in body", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "seed-resolver-"));
		await execAsync("git init", { cwd: tmp });
		await execAsync('git config user.email "test@test"', { cwd: tmp });
		await execAsync('git config user.name "Test"', { cwd: tmp });
		await writeFile(join(tmp, "f"), "x");
		await execAsync("git add f && git commit -m 'init'", { cwd: tmp });
		const { stdout: origSha } = await execAsync("git rev-parse HEAD", { cwd: tmp });
		await execAsync("git checkout -b allium/evolution", { cwd: tmp });
		await writeFile(join(tmp, "spec.allium"), "entity User {}");
		await writeFile(join(tmp, "allium-changelog.md"), "");
		await execAsync("git add spec.allium allium-changelog.md && git commit -m 'allium: init'", { cwd: tmp });
		const { stdout: alliumSha } = await execAsync("git rev-parse HEAD", { cwd: tmp });
		const body = `allium: init\n\n${formatOriginalLine(origSha.trim(), "init")}\n`;
		await execAsync(`git commit --amend -m "${body.replace(/"/g, '\\"')}"`, { cwd: tmp });
		const { stdout: amendedSha } = await execAsync("git rev-parse HEAD", { cwd: tmp });
		const resolved = await resolveSeedAlliumSha(tmp, origSha.trim(), "allium/evolution");
		expect(resolved).toBe(amendedSha.trim());
	});

	it("buildShaMapFromAlliumBranch builds original->allium map", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "seed-resolver-"));
		await execAsync("git init", { cwd: tmp });
		await execAsync('git config user.email "test@test"', { cwd: tmp });
		await execAsync('git config user.name "Test"', { cwd: tmp });
		await writeFile(join(tmp, "f"), "a");
		await execAsync("git add f && git commit -m 'a'", { cwd: tmp });
		const { stdout: sha1 } = await execAsync("git rev-parse HEAD", { cwd: tmp });
		await writeFile(join(tmp, "f"), "b");
		await execAsync("git add f && git commit -m 'b'", { cwd: tmp });
		const { stdout: sha2 } = await execAsync("git rev-parse HEAD", { cwd: tmp });
		await execAsync("git checkout -b allium/evolution", { cwd: tmp });
		await writeFile(join(tmp, "spec.allium"), "x");
		await writeFile(join(tmp, "allium-changelog.md"), "");
		await execAsync("git add spec.allium allium-changelog.md && git commit -m 'allium: a'", { cwd: tmp });
		const { stdout: a1 } = await execAsync("git rev-parse HEAD", { cwd: tmp });
		await execAsync(`git commit --amend -m "allium: a\n\n${formatOriginalLine(sha1.trim(), "a")}"`, { cwd: tmp });
		const { stdout: a1amended } = await execAsync("git rev-parse HEAD", { cwd: tmp });
		await writeFile(join(tmp, "spec.allium"), "y");
		await execAsync("git add spec.allium && git commit -m 'allium: b'", { cwd: tmp });
		await execAsync(`git commit --amend -m "allium: b\n\n${formatOriginalLine(sha2.trim(), "b")}"`, { cwd: tmp });
		const { stdout: a2 } = await execAsync("git rev-parse HEAD", { cwd: tmp });
		const shaMap = await buildShaMapFromAlliumBranch(tmp, a2.trim());
		expect(shaMap[sha1.trim()]).toBe(a1amended.trim());
		expect(shaMap[sha2.trim()]).toBe(a2.trim());
	});
});
