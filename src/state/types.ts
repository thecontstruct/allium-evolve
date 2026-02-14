import type { EvolutionConfig } from "../config.js";
import type { Segment } from "../dag/types.js";

export interface CompletedStep {
	originalSha: string;
	alliumSha: string;
	model: string;
	costUsd: number;
	timestamp: string;
}

export interface SegmentProgress {
	status: "pending" | "in-progress" | "complete" | "failed";
	completedSteps: CompletedStep[];
	currentSpec: string;
	currentChangelog: string;
}

export interface CompletedMerge {
	mergeSha: string;
	alliumSha: string;
	trunkSegmentId: string;
	branchSegmentId: string;
	timestamp: string;
}

export interface EvolutionState {
	version: 1;
	repoPath: string;
	targetRef: string;
	rootCommit: string;
	config: EvolutionConfig;
	segments: Segment[];
	segmentProgress: Record<string, SegmentProgress>;
	shaMap: Record<string, string>;
	completedMerges: CompletedMerge[];
	alliumBranchHead: string;
	totalCostUsd: number;
	totalSteps: number;
}
