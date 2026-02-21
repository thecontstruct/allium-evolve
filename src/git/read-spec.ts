import { exec } from "../utils/exec.js";

export async function readSpecFromCommit(repoPath: string, alliumSha: string): Promise<string> {
	const paths = ["spec.allium", "spec/_master.allium"];
	for (const path of paths) {
		let content: string;
		try {
			const { stdout } = await exec(`git show ${alliumSha}:${path}`, { cwd: repoPath });
			content = stdout.trim();
		} catch {
			continue;
		}

		if (path === "spec/_master.allium") {
			const { stdout: lsTree } = await exec(`git ls-tree ${alliumSha} spec/`, { cwd: repoPath });
			const lines = lsTree.trim().split("\n").filter(Boolean);
			// git ls-tree format: <mode> <type> <object>\t<file> — index [3] is the filename
			const moduleFiles = lines
				.map((line) => line.split(/\s+/)[3])
				.filter((name): name is string => typeof name === "string" && name.endsWith(".allium") && name !== "_master.allium");
			if (moduleFiles.length > 0) {
				throw new Error(
					`Multi-file spec detected in allium commit ${alliumSha.slice(0, 8)}. Resuming from an allium branch with multi-file specs is not yet supported. Flatten the spec to a single file or use a commit with a single-file spec.`,
				);
			}
		}

		return content;
	}
	throw new Error(
		`Could not read spec from allium commit ${alliumSha.slice(0, 8)}. Expected spec.allium or spec/_master.allium.`,
	);
}

export async function readChangelogFromCommit(repoPath: string, alliumSha: string): Promise<string> {
	try {
		const { stdout } = await exec(`git show ${alliumSha}:allium-changelog.md`, { cwd: repoPath });
		return stdout;
	} catch {
		return "";
	}
}
