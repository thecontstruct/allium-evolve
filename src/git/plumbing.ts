import { randomBytes } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "../utils/exec.js";

export interface CreateAlliumCommitOpts {
	repoPath: string;
	originalSha: string;
	parentShas: string[];
	specContent?: string;
	specFiles?: Map<string, string>;
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
	const { repoPath, originalSha, parentShas, specContent, specFiles, changelogContent, commitMessage } = opts;

	const tempIndex = join(repoPath, ".git", `index.allium.${randomBytes(8).toString("hex")}`);
	const env = { ...process.env, GIT_INDEX_FILE: tempIndex };

	try {
		const treeSha = await getTreeSha(repoPath, originalSha);
		await exec(`git read-tree ${treeSha}`, { cwd: repoPath, env });

		if (specFiles && specFiles.size > 0) {
			for (const [filePath, content] of specFiles) {
				const blobSha = await hashObject(repoPath, content, env);
				await exec(`git update-index --add --cacheinfo 100644,${blobSha},${filePath}`, {
					cwd: repoPath,
					env,
				});
			}
		} else if (specContent !== undefined) {
			const specBlobSha = await hashObject(repoPath, specContent, env);
			await exec(`git update-index --add --cacheinfo 100644,${specBlobSha},spec.allium`, {
				cwd: repoPath,
				env,
			});
		}

		const changelogBlobSha = await hashObject(repoPath, changelogContent, env);
		await exec(`git update-index --add --cacheinfo 100644,${changelogBlobSha},allium-changelog.md`, {
			cwd: repoPath,
			env,
		});

		const { stdout: treeOut } = await exec("git write-tree", { cwd: repoPath, env });
		const newTreeSha = treeOut.trim();

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
