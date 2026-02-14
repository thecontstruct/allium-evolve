export interface CommitNode {
	sha: string;
	parents: string[];
	children: string[];
	message: string;
	authorDate: string;
	isTrunk: boolean;
}

export interface Segment {
	id: string;
	type: "trunk" | "branch" | "dead-end";
	commits: string[];
	forkFrom: string | null;
	mergesInto: string | null;
	dependsOn: string[];
}

export interface ForkPoint {
	sha: string;
	branchSegmentIds: string[];
}

export interface MergePoint {
	sha: string;
	trunkSegmentId: string;
	branchSegmentId: string;
}
