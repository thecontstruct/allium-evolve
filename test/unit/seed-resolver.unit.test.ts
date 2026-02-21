import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
	buildShaMapFromAlliumBranch,
	resolveFromAlliumBranch,
} from "../../src/evolution/seed-resolver.js";
import { formatOriginalLine } from "../../src/git/commit-metadata.js";

const execAsync = promisify(exec);

async function initGitRepo(tmpPath: string) {
	await execAsync("git init", { cwd: tmpPath });
	await execAsync('git config user.email "test@test"', { cwd: tmpPath });
	await execAsync('git config user.name "Test"', { cwd: tmpPath });
}

async function commitWithMessage(tmpPath: string, body: string, amend = false): Promise<void> {
	const msgFile = join(tmpPath, ".git", "COMMIT_MSG_TMP");
	await writeFile(msgFile, body, "utf-8");
	const amendFlag = amend ? "--amend " : "";
	await execAsync(`git commit ${amendFlag}--allow-empty -F "${msgFile}"`, { cwd: tmpPath });
}

async function makeTwoCommitAlliumSetup(tmp: string): Promise<{
	sha1: string;
	sha2: string;
	a1amended: string;
	a2: string;
}> {
	await initGitRepo(tmp);
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
	await commitWithMessage(tmp, `allium: a\n\n${formatOriginalLine(sha1.trim(), "a")}\n`, true);
	const { stdout: a1amended } = await execAsync("git rev-parse HEAD", { cwd: tmp });
	await writeFile(join(tmp, "spec.allium"), "y");
	await execAsync("git add spec.allium && git commit -m 'allium: b'", { cwd: tmp });
	await commitWithMessage(tmp, `allium: b\n\n${formatOriginalLine(sha2.trim(), "b")}\n`, true);
	const { stdout: a2 } = await execAsync("git rev-parse HEAD", { cwd: tmp });
	return { sha1: sha1.trim(), sha2: sha2.trim(), a1amended: a1amended.trim(), a2: a2.trim() };
}

describe("seed-resolver", () => {
	it("returns null when allium branch does not exist", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "seed-resolver-"));
		await initGitRepo(tmp);
		await writeFile(join(tmp, "f"), "x");
		await execAsync("git add f && git commit -m 'init'", { cwd: tmp });
		const resolved = await resolveFromAlliumBranch(tmp, "allium/evolution");
		expect(resolved).toBeNull();
	});

	it("resolves when tip commit has an Original: tag", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "seed-resolver-"));
		await initGitRepo(tmp);
		await writeFile(join(tmp, "f"), "x");
		await execAsync("git add f && git commit -m 'init'", { cwd: tmp });
		const { stdout: origSha } = await execAsync("git rev-parse HEAD", { cwd: tmp });
		await execAsync("git checkout -b allium/evolution", { cwd: tmp });
		await writeFile(join(tmp, "spec.allium"), "entity User {}");
		await writeFile(join(tmp, "allium-changelog.md"), "");
		await execAsync("git add spec.allium allium-changelog.md", { cwd: tmp });
		await commitWithMessage(tmp, `allium: init\n\n${formatOriginalLine(origSha.trim(), "init")}\n`);
		const { stdout: tipSha } = await execAsync("git rev-parse HEAD", { cwd: tmp });
		const resolved = await resolveFromAlliumBranch(tmp, "allium/evolution");
		expect(resolved).not.toBeNull();
		expect(resolved!.tipAlliumSha).toBe(tipSha.trim());
		expect(resolved!.startAfterSha).toBe(origSha.trim());
		expect(resolved!.commitsBeyondAnchor).toBe(0);
		expect(resolved!.shaMap[origSha.trim()]).toBe(tipSha.trim());
		expect(resolved!.lastProcessedMessage).toBe("init");
	});

	it("walks back when tip has no Original: tag", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "seed-resolver-"));
		await initGitRepo(tmp);
		await writeFile(join(tmp, "f"), "a");
		await execAsync("git add f && git commit -m 'a'", { cwd: tmp });
		const { stdout: origSha } = await execAsync("git rev-parse HEAD", { cwd: tmp });
		await execAsync("git checkout -b allium/evolution", { cwd: tmp });
		await writeFile(join(tmp, "spec.allium"), "entity User {}");
		await writeFile(join(tmp, "allium-changelog.md"), "");
		await execAsync("git add spec.allium allium-changelog.md", { cwd: tmp });
		await commitWithMessage(tmp, `allium: init\n\n${formatOriginalLine(origSha.trim(), "a")}\n`);
		await execAsync(
			"git commit --allow-empty -m 'reconciliation: no Original tag'",
			{ cwd: tmp },
		);
		const { stdout: tipSha } = await execAsync("git rev-parse HEAD", { cwd: tmp });
		const resolved = await resolveFromAlliumBranch(tmp, "allium/evolution");
		expect(resolved).not.toBeNull();
		expect(resolved!.tipAlliumSha).toBe(tipSha.trim());
		expect(resolved!.startAfterSha).toBe(origSha.trim());
		expect(resolved!.commitsBeyondAnchor).toBe(1);
		expect(resolved!.lastProcessedMessage).toBe("a");
	});

	it("throws when branch exists but no commit has an Original: tag", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "seed-resolver-"));
		await initGitRepo(tmp);
		await writeFile(join(tmp, "f"), "x");
		await execAsync("git add f && git commit -m 'init'", { cwd: tmp });
		await execAsync("git checkout -b allium/evolution", { cwd: tmp });
		await writeFile(join(tmp, "spec.allium"), "entity User {}");
		await writeFile(join(tmp, "allium-changelog.md"), "");
		await execAsync("git add spec.allium allium-changelog.md && git commit -m 'allium: init'", {
			cwd: tmp,
		});
		await expect(resolveFromAlliumBranch(tmp, "allium/evolution")).rejects.toThrow(
			"No Original: tag found",
		);
	});

	it("shaMap contains all Original: mappings from full history", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "seed-resolver-"));
		const { sha1, sha2, a1amended, a2 } = await makeTwoCommitAlliumSetup(tmp);
		const resolved = await resolveFromAlliumBranch(tmp, "allium/evolution");
		expect(resolved).not.toBeNull();
		expect(resolved!.shaMap[sha1]).toBe(a1amended);
		expect(resolved!.shaMap[sha2]).toBe(a2);
	});

	it("buildShaMapFromAlliumBranch builds original->allium map", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "seed-resolver-"));
		const { sha1, sha2, a1amended, a2 } = await makeTwoCommitAlliumSetup(tmp);
		const shaMap = await buildShaMapFromAlliumBranch(tmp, a2);
		expect(shaMap[sha1]).toBe(a1amended);
		expect(shaMap[sha2]).toBe(a2);
	});
});
