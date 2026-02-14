import { randomBytes } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "../utils/exec.js";

export interface CreateAlliumCommitOpts {
	repoPath: string;
	originalSha: string;
	parentShas: string[];
	specContent: string;
	changelogContent: string;
	commitMessage: string;
	segmentId?: string;
}

async function hashObject(repoPath: string, content: string, env: Record<string, string | undefined>): Promise<string> {
	const tmpFile = join(repoPath, ".git", `tmp-${randomBytes(8).toString("hex")}`);
	await writeFile(tmpFile, content);
	try {
		const { stdout } = await exec(`git hash-object -w "${tmpFile}"`, { cwd: repoPath, env });
		return stdout.trim();
	} finally {
		await unlink(tmpFile).catch(() => {});
	}
}

export async function createAlliumCommit(opts: CreateAlliumCommitOpts): Promise<string> {
	const { repoPath, originalSha, parentShas, specContent, changelogContent, commitMessage } = opts;

	const tempIndex = join(repoPath, ".git", `index.allium.${randomBytes(8).toString("hex")}`);
	const env = { ...process.env, GIT_INDEX_FILE: tempIndex };

	try {
		// 1. Get tree from original commit
		const treeSha = await getTreeSha(repoPath, originalSha);

		// 2. Read original tree into temp index
		await exec(`git read-tree ${treeSha}`, { cwd: repoPath, env });

		// 3. Hash spec and changelog blobs
		const specBlobSha = await hashObject(repoPath, specContent, env);
		const changelogBlobSha = await hashObject(repoPath, changelogContent, env);

		// 4. Add blobs to temp index
		await exec(`git update-index --add --cacheinfo 100644,${specBlobSha},spec.allium`, { cwd: repoPath, env });
		await exec(`git update-index --add --cacheinfo 100644,${changelogBlobSha},allium-changelog.md`, {
			cwd: repoPath,
			env,
		});

		// 5. Write tree from temp index
		const { stdout: treeOut } = await exec("git write-tree", { cwd: repoPath, env });
		const newTreeSha = treeOut.trim();

		// 6. Create commit with parent(s)
		const parentFlags = parentShas.map((p) => `-p ${p}`).join(" ");
		const { stdout: commitOut } = await exec(
			`git commit-tree ${newTreeSha} ${parentFlags} -m "${commitMessage.replace(/"/g, '\\"')}"`,
			{ cwd: repoPath },
		);
		return commitOut.trim();
	} finally {
		await unlink(tempIndex).catch(() => {});
	}
}

export async function updateRef(repoPath: string, ref: string, sha: string): Promise<void> {
	await exec(`git update-ref ${ref} ${sha}`, { cwd: repoPath });
}

export async function getTreeSha(repoPath: string, commitSha: string): Promise<string> {
	const { stdout } = await exec(`git rev-parse ${commitSha}^{tree}`, { cwd: repoPath });
	return stdout.trim();
}
