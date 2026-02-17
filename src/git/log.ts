import type { CommitNode } from "../dag/types.js";
import { exec } from "../utils/exec.js";

const FIELD_SEP = "<<SEP>>";
const RECORD_SEP = "<<REC>>";

export async function parseGitLog(repoPath: string, targetRef?: string): Promise<Map<string, CommitNode>> {
	const format = ["%H", "%P", "%s", "%aI"].join(FIELD_SEP) + RECORD_SEP;
	const refArg = targetRef ?? "--all";
	const { stdout } = await exec(`git log ${refArg} --format="${format}"`, { cwd: repoPath });

	const nodes = new Map<string, CommitNode>();
	const records = stdout.split(RECORD_SEP).filter((r) => r.trim().length > 0);

	for (const record of records) {
		const fields = record.trim().split(FIELD_SEP);
		if (fields.length < 4) {
			continue;
		}

		const [sha, parentStr, message, authorDate] = fields as [string, string, string, string];
		const parents = parentStr ? parentStr.split(" ").filter(Boolean) : [];

		nodes.set(sha, {
			sha,
			parents,
			children: [],
			message,
			authorDate,
			isTrunk: false,
		});
	}

	for (const node of nodes.values()) {
		for (const parentSha of node.parents) {
			const parent = nodes.get(parentSha);
			if (parent) {
				parent.children.push(node.sha);
			}
		}
	}

	return nodes;
}
