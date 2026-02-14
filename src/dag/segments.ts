import type { CommitNode, Segment } from "./types.js";

/**
 * Decompose a trunk-annotated DAG into linear segments in topological order.
 *
 * Precondition: `identifyTrunk` has already been called on the DAG so that
 * every trunk commit has `isTrunk === true`.
 */
export function decompose(dag: Map<string, CommitNode>): Segment[] {
	const shaToSegmentId = new Map<string, string>();
	const allSegments: Segment[] = [];

	// ── 1. Build the ordered trunk path (root → tip) ───────────────────
	const trunkPath = buildOrderedTrunkPath(dag);

	// ── 2. Split the trunk into segments at merge commits ──────────────
	let trunkIndex = 0;
	let currentCommits: string[] = [];

	function flushTrunkSegment(): void {
		if (currentCommits.length === 0) {
			return;
		}
		const id = `trunk-${trunkIndex}`;
		allSegments.push({
			id,
			type: "trunk",
			commits: currentCommits,
			forkFrom: null,
			mergesInto: null,
			dependsOn: [],
		});
		for (const s of currentCommits) {
			shaToSegmentId.set(s, id);
		}
		trunkIndex++;
		currentCommits = [];
	}

	for (const node of trunkPath) {
		if (node.parents.length > 1 && currentCommits.length > 0) {
			flushTrunkSegment();
		}
		currentCommits.push(node.sha);
	}
	flushTrunkSegment();

	// ── 3. Discover branch / dead-end segments ─────────────────────────
	let branchIndex = 0;
	let deadEndIndex = 0;

	for (const node of trunkPath) {
		const nonTrunkChildren = node.children.filter((ch) => !dag.get(ch)?.isTrunk);

		for (const childSha of nonTrunkChildren) {
			const { commits, mergesInto } = traceBranch(childSha, dag);
			const type = mergesInto ? "branch" : "dead-end";
			const id = type === "branch" ? `branch-${branchIndex++}` : `dead-end-${deadEndIndex++}`;

			allSegments.push({
				id,
				type,
				commits,
				forkFrom: node.sha,
				mergesInto,
				dependsOn: [],
			});
			for (const s of commits) {
				shaToSegmentId.set(s, id);
			}
		}
	}

	// ── 4. Compute dependsOn edges ─────────────────────────────────────
	for (const seg of allSegments) {
		if (seg.type === "trunk") {
			// A trunk segment depends on every segment that contains a parent
			// of its first commit.
			const firstCommit = dag.get(seg.commits[0]!);
			if (!firstCommit) {
				continue;
			}
			for (const parentSha of firstCommit.parents) {
				const depId = shaToSegmentId.get(parentSha);
				if (depId && depId !== seg.id && !seg.dependsOn.includes(depId)) {
					seg.dependsOn.push(depId);
				}
			}
		} else {
			// Branch / dead-end depends on the trunk segment that holds forkFrom.
			if (seg.forkFrom) {
				const depId = shaToSegmentId.get(seg.forkFrom);
				if (depId && !seg.dependsOn.includes(depId)) {
					seg.dependsOn.push(depId);
				}
			}
		}
	}

	// ── 5. Topological sort (DFS) ──────────────────────────────────────
	return topologicalSort(allSegments);
}

// ── helpers ────────────────────────────────────────────────────────────

function buildOrderedTrunkPath(dag: Map<string, CommitNode>): CommitNode[] {
	const root = [...dag.values()].find((n) => n.isTrunk && n.parents.length === 0);
	if (!root) {
		throw new Error("No trunk root found (commit with 0 parents)");
	}

	const path: CommitNode[] = [root];
	let current = root;

	for (;;) {
		const trunkChild = current.children.find((sha) => dag.get(sha)?.isTrunk);
		if (!trunkChild) {
			break;
		}
		const child = dag.get(trunkChild)!;
		path.push(child);
		current = child;
	}

	return path;
}

function traceBranch(startSha: string, dag: Map<string, CommitNode>): { commits: string[]; mergesInto: string | null } {
	const commits: string[] = [];
	let currentSha: string | undefined = startSha;

	while (currentSha) {
		const current = dag.get(currentSha);
		if (!current || current.isTrunk) {
			break;
		}

		commits.push(current.sha);

		// If any child is a trunk commit, this branch merges there.
		const trunkChild = current.children.find((sha) => dag.get(sha)?.isTrunk);
		if (trunkChild) {
			return { commits, mergesInto: trunkChild };
		}

		// Follow the next non-trunk child (linear branch assumption).
		const nextChild = current.children.find((sha) => !dag.get(sha)?.isTrunk);
		currentSha = nextChild;
	}

	return { commits, mergesInto: null };
}

function topologicalSort(segments: Segment[]): Segment[] {
	const segMap = new Map<string, Segment>();
	for (const seg of segments) {
		segMap.set(seg.id, seg);
	}

	const result: Segment[] = [];
	const visited = new Set<string>();

	function visit(id: string): void {
		if (visited.has(id)) {
			return;
		}
		visited.add(id);
		const seg = segMap.get(id)!;
		for (const depId of seg.dependsOn) {
			visit(depId);
		}
		result.push(seg);
	}

	for (const seg of segments) {
		visit(seg.id);
	}

	return result;
}
