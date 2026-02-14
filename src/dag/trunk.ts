import { exec } from "../utils/exec.js";
import type { CommitNode } from "./types.js";

export async function identifyTrunk(dag: Map<string, CommitNode>, repoPath: string, targetRef: string): Promise<void> {
	const { stdout } = await exec(`git rev-parse ${targetRef}`, {
		cwd: repoPath,
	});
	const headSha = stdout.trim();

	let current = dag.get(headSha);
	if (!current) {
		throw new Error(`rev-parse resolved ${targetRef} to ${headSha}, which is not in the DAG`);
	}

	while (current) {
		current.isTrunk = true;
		const firstParent = current.parents[0];
		if (!firstParent) {
			break;
		}
		current = dag.get(firstParent);
	}
}
