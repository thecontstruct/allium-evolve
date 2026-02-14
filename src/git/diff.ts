import { exec } from "../utils/exec.js";

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf899d15f3f762975";

export function getEmptyTreeSha(): string {
	return EMPTY_TREE_SHA;
}

export async function getDiff(repoPath: string, fromSha: string | null, toSha: string): Promise<string> {
	if (fromSha === null) {
		const { stdout } = await exec(`git diff-tree --root -p ${toSha}`, { cwd: repoPath });
		return stdout;
	}

	const { stdout } = await exec(`git diff ${fromSha}..${toSha}`, { cwd: repoPath });
	return stdout;
}

export async function getDiffstat(repoPath: string, fromSha: string | null, toSha: string): Promise<string> {
	if (fromSha === null) {
		const { stdout } = await exec(`git diff-tree --root --stat ${toSha}`, { cwd: repoPath });
		return stdout;
	}

	const { stdout } = await exec(`git diff --stat ${fromSha}..${toSha}`, { cwd: repoPath });
	return stdout;
}
