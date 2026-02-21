import { exec } from "../utils/exec.js";

export async function readSpecFromCommit(repoPath: string, alliumSha: string): Promise<string> {
	const paths = ["spec.allium", "spec/_master.allium"];
	for (const path of paths) {
		try {
			const { stdout } = await exec(`git show ${alliumSha}:${path}`, { cwd: repoPath });
			const content = stdout.trim();
			if (path === "spec/_master.allium") {
				try {
					const { stdout: lsTree } = await exec(`git ls-tree ${alliumSha} spec/`, { cwd: repoPath });
					const lines = lsTree.trim().split("\n").filter(Boolean);
					const moduleFiles = lines
						.map((line) => line.split(/\s+/)[2])
						.filter((name): name is string => typeof name === "string" && name.endsWith(".allium") && name !== "_master.allium");
					if (moduleFiles.length > 0) {
						throw new Error(
							`Multi-file spec detected in allium commit ${alliumSha.slice(0, 8)}. --start-after does not yet support multi-file specs. Provide --seed-spec pointing to a single-file commit or flatten the spec.`,
						);
					}
				} catch (err) {
					if (err instanceof Error && err.message.includes("Multi-file spec")) {
						throw err;
					}
				}
			}
			return content;
		} catch {
			continue;
		}
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
