import type { CommitNode } from "./types.js";

export function collectAncestors(dag: Map<string, CommitNode>, startSha: string): Set<string> {
	const result = new Set<string>();
	const queue: string[] = [startSha];

	while (queue.length > 0) {
		const sha = queue.shift()!;
		if (result.has(sha)) continue;
		result.add(sha);

		const node = dag.get(sha);
		if (!node) continue;
		for (const parent of node.parents) {
			queue.push(parent);
		}
	}

	return result;
}
