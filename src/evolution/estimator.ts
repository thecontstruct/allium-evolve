import { getModelForStep } from "../claude/models.js";
import type { EvolutionConfig } from "../config.js";
import type { CommitNode, Segment } from "../dag/types.js";
import type { StateTracker } from "../state/tracker.js";

interface CostRange {
	low: number;
	high: number;
}

const MODEL_COST_PER_STEP: Record<string, CostRange> = {
	sonnet: { low: 0.01, high: 0.05 },
	opus: { low: 0.05, high: 0.25 },
	haiku: { low: 0.002, high: 0.01 },
};

const DEFAULT_COST_RANGE: CostRange = { low: 0.01, high: 0.10 };

const AVG_SECONDS_PER_STEP = { low: 45, high: 90 };

export interface SetupStats {
	totalCommits: number;
	segmentsByType: Record<string, { count: number; commits: number }>;
	totalSteps: number;
	completedSteps: number;
	remainingSteps: number;
	mergePoints: number;
	modelDistribution: Record<string, number>;
	estimatedCost: CostRange;
	costSoFar: number;
	criticalPathSteps: number;
	estimatedWallClock: { low: number; high: number };
	concurrency: number;
	isResume: boolean;
}

export function computeSetupStats(
	dag: Map<string, CommitNode>,
	segments: Segment[],
	stateTracker: StateTracker,
	config: EvolutionConfig,
	isResume: boolean,
): SetupStats {
	const state = stateTracker.getState();

	const segmentsByType: Record<string, { count: number; commits: number }> = {};
	let totalSteps = 0;
	let mergePoints = 0;
	const modelDistribution: Record<string, number> = {};

	for (const seg of segments) {
		const entry = segmentsByType[seg.type] ?? { count: 0, commits: 0 };
		entry.count += 1;
		entry.commits += seg.commits.length;
		segmentsByType[seg.type] = entry;
		totalSteps += seg.commits.length;

		for (const commitSha of seg.commits) {
			const node = dag.get(commitSha);
			const isRoot = node !== undefined && node.parents.length === 0;
			const isMerge = node !== undefined && node.parents.length > 1 && seg.type === "trunk";

			let model: string;
			if (isRoot) {
				model = getModelForStep("initial-commit", config);
			} else if (isMerge) {
				model = getModelForStep("merge", config);
				mergePoints += 1;
			} else {
				model = getModelForStep("evolve", config);
			}
			modelDistribution[model] = (modelDistribution[model] ?? 0) + 1;
		}
	}

	const completedSteps = state.totalSteps;
	const remainingSteps = totalSteps - completedSteps;

	let estimatedCostLow = 0;
	let estimatedCostHigh = 0;
	for (const [model, count] of Object.entries(modelDistribution)) {
		const completedForModel = Math.min(count, completedSteps);
		const remainingForModel = count - completedForModel;
		const range = MODEL_COST_PER_STEP[model] ?? DEFAULT_COST_RANGE;
		estimatedCostLow += remainingForModel * range.low;
		estimatedCostHigh += remainingForModel * range.high;
	}

	const criticalPathSteps = computeCriticalPath(segments);

	const effectiveParallelSteps = Math.max(
		criticalPathSteps,
		Math.ceil(remainingSteps / config.maxConcurrency),
	);
	const estimatedWallClock = {
		low: effectiveParallelSteps * AVG_SECONDS_PER_STEP.low,
		high: effectiveParallelSteps * AVG_SECONDS_PER_STEP.high,
	};

	return {
		totalCommits: dag.size,
		segmentsByType,
		totalSteps,
		completedSteps,
		remainingSteps,
		mergePoints,
		modelDistribution,
		estimatedCost: { low: estimatedCostLow, high: estimatedCostHigh },
		costSoFar: state.totalCostUsd,
		criticalPathSteps,
		estimatedWallClock,
		concurrency: config.maxConcurrency,
		isResume,
	};
}

function computeCriticalPath(segments: Segment[]): number {
	const segmentMap = new Map<string, Segment>();
	for (const seg of segments) {
		segmentMap.set(seg.id, seg);
	}

	const memo = new Map<string, number>();

	function longestPath(segId: string): number {
		const cached = memo.get(segId);
		if (cached !== undefined) {
			return cached;
		}
		const seg = segmentMap.get(segId);
		if (!seg) {
			return 0;
		}

		let maxDepLength = 0;
		for (const dep of seg.dependsOn) {
			maxDepLength = Math.max(maxDepLength, longestPath(dep));
		}

		const result = maxDepLength + seg.commits.length;
		memo.set(segId, result);
		return result;
	}

	let critical = 0;
	for (const seg of segments) {
		critical = Math.max(critical, longestPath(seg.id));
	}
	return critical;
}

function formatDuration(seconds: number): string {
	if (seconds < 60) {
		return `${Math.round(seconds)}s`;
	}
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours > 0) {
		return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	}
	return `${minutes}m`;
}

export function formatSetupStats(stats: SetupStats): string {
	const lines: string[] = [];

	lines.push("");
	lines.push("┌─────────────────────────────────────────┐");
	lines.push("│         allium-evolve setup summary      │");
	lines.push("└─────────────────────────────────────────┘");
	lines.push("");

	if (stats.isResume) {
		lines.push("  Status:           RESUMING from saved state");
	} else {
		lines.push("  Status:           NEW run");
	}

	lines.push(`  Total commits:    ${stats.totalCommits}`);
	lines.push("");

	lines.push("  Segments:");
	for (const [type, info] of Object.entries(stats.segmentsByType)) {
		lines.push(`    ${type.padEnd(12)} ${String(info.count).padStart(3)} segments, ${String(info.commits).padStart(5)} commits`);
	}
	lines.push("");

	lines.push("  Steps:");
	lines.push(`    Total:          ${stats.totalSteps}`);
	if (stats.isResume) {
		lines.push(`    Completed:      ${stats.completedSteps}`);
	}
	lines.push(`    Remaining:      ${stats.remainingSteps}`);
	lines.push(`    Merge points:   ${stats.mergePoints}`);
	lines.push("");

	lines.push("  Model distribution (all steps):");
	for (const [model, count] of Object.entries(stats.modelDistribution)) {
		lines.push(`    ${model.padEnd(12)} ${String(count).padStart(5)} steps`);
	}
	lines.push("");

	lines.push("  Cost estimate (remaining steps):");
	lines.push(`    Low:            $${stats.estimatedCost.low.toFixed(2)}`);
	lines.push(`    High:           $${stats.estimatedCost.high.toFixed(2)}`);
	if (stats.isResume && stats.costSoFar > 0) {
		lines.push(`    Spent so far:   $${stats.costSoFar.toFixed(4)}`);
	}
	lines.push("");

	lines.push("  Time estimate:");
	lines.push(`    Critical path:  ${stats.criticalPathSteps} steps (sequential minimum)`);
	lines.push(`    Concurrency:    ${stats.concurrency}`);
	lines.push(`    Wall clock:     ${formatDuration(stats.estimatedWallClock.low)} – ${formatDuration(stats.estimatedWallClock.high)}`);
	lines.push("");

	lines.push(`  Ready:            run without --setup-only to begin processing`);
	lines.push("");

	return lines.join("\n");
}
