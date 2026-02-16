import type { EvolutionConfig } from "../config.js";
import { buildDag } from "../dag/builder.js";
import { decompose } from "../dag/segments.js";
import { identifyTrunk } from "../dag/trunk.js";
import type { CommitNode, Segment } from "../dag/types.js";
import { updateRef } from "../git/plumbing.js";
import { createScheduler, type ReconciliationScheduler } from "../reconciliation/scheduler.js";
import { StateTracker } from "../state/tracker.js";
import type { CompletedStep } from "../state/types.js";
import { runMerge } from "./merge-runner.js";
import { runSegment, type SegmentRunnerResult } from "./segment-runner.js";

export async function runEvolution(config: EvolutionConfig): Promise<void> {
	console.error(`[allium-evolve] Starting evolution for ${config.repoPath}`);
	console.error(`[allium-evolve] Target ref: ${config.targetRef}`);
	console.error(`[allium-evolve] Parallel branches: ${config.parallelBranches}`);

	const dag = await buildDag(config.repoPath);
	await identifyTrunk(dag, config.repoPath, config.targetRef);
	const segments = decompose(dag);

	const rootNodes = [...dag.values()].filter((n) => n.parents.length === 0);
	if (rootNodes.length === 0) {
		throw new Error("No root commit found in DAG");
	}
	const rootCommit = rootNodes[0]!.sha;

	console.error(`[allium-evolve] DAG: ${dag.size} commits, ${segments.length} segments`);
	for (const seg of segments) {
		console.error(`  ${seg.id} (${seg.type}): ${seg.commits.length} commits, depends on [${seg.dependsOn.join(", ")}]`);
	}

	const stateTracker = new StateTracker(config.stateFile);
	const loaded = await stateTracker.load();
	if (loaded) {
		console.error("[allium-evolve] Resumed from existing state");
	} else {
		stateTracker.initState(config, segments, rootCommit);
		await stateTracker.save();
	}

	const segmentResults = new Map<string, SegmentRunnerResult>();
	const scheduler = createScheduler(config);

	if (config.reconciliation.strategy !== "none") {
		console.error(`[allium-evolve] Reconciliation: ${config.reconciliation.strategy} (interval: ${config.reconciliation.interval})`);
	}

	if (config.parallelBranches) {
		await runParallel(config, dag, segments, stateTracker, segmentResults, scheduler);
	} else {
		await runSequential(config, dag, segments, stateTracker, segmentResults, scheduler);
	}

	const state = stateTracker.getState();
	console.error("[allium-evolve] Evolution complete!");
	console.error(`  Total steps: ${state.totalSteps}`);
	console.error(`  Total cost: $${state.totalCostUsd.toFixed(4)}`);
	console.error(`  Allium branch: ${config.alliumBranch} (${state.alliumBranchHead.slice(0, 8)})`);
}

async function runSequential(
	config: EvolutionConfig,
	dag: Map<string, CommitNode>,
	segments: Segment[],
	stateTracker: StateTracker,
	segmentResults: Map<string, SegmentRunnerResult>,
	scheduler: ReconciliationScheduler,
): Promise<void> {
	for (const segment of segments) {
		await processSegmentOrMerge(config, dag, segment, segments, stateTracker, segmentResults, scheduler);
	}
}

async function runParallel(
	config: EvolutionConfig,
	dag: Map<string, CommitNode>,
	segments: Segment[],
	stateTracker: StateTracker,
	segmentResults: Map<string, SegmentRunnerResult>,
	scheduler: ReconciliationScheduler,
): Promise<void> {
	const completed = new Set<string>();
	const inProgress = new Map<string, Promise<void>>();

	function isReady(seg: Segment): boolean {
		return seg.dependsOn.every((dep) => completed.has(dep));
	}

	async function processAndTrack(seg: Segment): Promise<void> {
		try {
			await processSegmentOrMerge(config, dag, seg, segments, stateTracker, segmentResults, scheduler);
			completed.add(seg.id);
		} catch (err) {
			stateTracker.updateSegmentStatus(seg.id, "failed");
			await stateTracker.save();
			throw err;
		} finally {
			inProgress.delete(seg.id);
		}
	}

	while (completed.size < segments.length) {
		const ready = segments.filter((s) => !completed.has(s.id) && !inProgress.has(s.id) && isReady(s));

		if (ready.length === 0 && inProgress.size === 0) {
			const remaining = segments.filter((s) => !completed.has(s.id));
			const failed = remaining.filter((s) => stateTracker.getSegmentProgress(s.id)?.status === "failed");
			if (failed.length > 0) {
				throw new Error(`Evolution halted: segments [${failed.map((s) => s.id).join(", ")}] failed. Resume to retry.`);
			}
			throw new Error("Deadlock: no segments ready and none in progress");
		}

		for (const seg of ready) {
			if (inProgress.size >= config.maxConcurrency) {
				break;
			}
			const promise = processAndTrack(seg);
			inProgress.set(seg.id, promise);
		}

		if (inProgress.size > 0) {
			await Promise.race(inProgress.values());
		}
	}
}

async function processSegmentOrMerge(
	config: EvolutionConfig,
	dag: Map<string, CommitNode>,
	segment: Segment,
	allSegments: Segment[],
	stateTracker: StateTracker,
	segmentResults: Map<string, SegmentRunnerResult>,
	scheduler: ReconciliationScheduler,
): Promise<void> {
	const progress = stateTracker.getSegmentProgress(segment.id);
	if (progress?.status === "complete") {
		console.error(`[allium-evolve] Skipping completed segment: ${segment.id}`);
		return;
	}

	const firstCommitSha = segment.commits[0];
	if (!firstCommitSha) {
		return;
	}

	const firstCommit = dag.get(firstCommitSha);
	const isMergeStart = firstCommit && firstCommit.parents.length > 1 && segment.type === "trunk";

	if (isMergeStart) {
		await handleMergeAndSegment(config, dag, segment, allSegments, stateTracker, segmentResults, scheduler);
	} else {
		await handleSegment(config, dag, segment, stateTracker, segmentResults, scheduler);
	}
}

async function handleSegment(
	config: EvolutionConfig,
	dag: Map<string, CommitNode>,
	segment: Segment,
	stateTracker: StateTracker,
	segmentResults: Map<string, SegmentRunnerResult>,
	scheduler: ReconciliationScheduler,
): Promise<void> {
	console.error(
		`[allium-evolve] Processing segment: ${segment.id} (${segment.type}, ${segment.commits.length} commits)`,
	);

	let initialSpec = "";
	let initialChangelog = "";
	let parentAlliumSha: string | null = null;
	let trunkContextShas: string[] | undefined;

	if (segment.dependsOn.length > 0) {
		const depId = segment.dependsOn[0]!;
		const depResult = segmentResults.get(depId);
		if (depResult) {
			initialSpec = depResult.currentSpec;
			initialChangelog = depResult.currentChangelog;
			parentAlliumSha = depResult.tipAlliumSha;
		} else {
			const depProgress = stateTracker.getSegmentProgress(depId);
			if (depProgress) {
				initialSpec = depProgress.currentSpec;
				initialChangelog = depProgress.currentChangelog;
				const lastStep = depProgress.completedSteps[depProgress.completedSteps.length - 1];
				if (lastStep) {
					parentAlliumSha = lastStep.alliumSha;
				}
			}
		}
	}

	if (segment.forkFrom && segment.type !== "trunk") {
		const forkNode = dag.get(segment.forkFrom);
		if (forkNode) {
			trunkContextShas = getTrunkContextBefore(dag, segment.forkFrom, config.windowSize - 1);
		}
	}

	stateTracker.updateSegmentStatus(segment.id, "in-progress");
	await stateTracker.save();

	const result = await runSegment({
		segment,
		config,
		dag,
		initialSpec,
		initialChangelog,
		parentAlliumSha,
		trunkContextShas,
		onStepComplete: async (step: CompletedStep, spec: string, changelog: string) => {
			stateTracker.recordStep(segment.id, step, spec, changelog);
			await stateTracker.save();
		},
		scheduler,
		stateTracker,
	});

	segmentResults.set(segment.id, result);
	stateTracker.updateSegmentStatus(segment.id, "complete");

	if (segment.type === "trunk") {
		await updateRef(config.repoPath, `refs/heads/${config.alliumBranch}`, result.tipAlliumSha);
		stateTracker.updateBranchHead(result.tipAlliumSha);
	}

	await stateTracker.save();
	console.error(`[allium-evolve] Completed segment: ${segment.id}`);
}

async function handleMergeAndSegment(
	config: EvolutionConfig,
	dag: Map<string, CommitNode>,
	segment: Segment,
	allSegments: Segment[],
	stateTracker: StateTracker,
	segmentResults: Map<string, SegmentRunnerResult>,
	scheduler: ReconciliationScheduler,
): Promise<void> {
	const mergeSha = segment.commits[0]!;
	const mergeNode = dag.get(mergeSha)!;

	const trunkDepId = segment.dependsOn.find((id) => {
		const dep = allSegments.find((s) => s.id === id);
		return dep?.type === "trunk";
	});
	const branchDepId = segment.dependsOn.find((id) => {
		const dep = allSegments.find((s) => s.id === id);
		return dep?.type === "branch";
	});

	if (!trunkDepId || !branchDepId) {
		console.error(
			`[allium-evolve] Merge ${mergeSha.slice(0, 8)} missing trunk or branch dep, treating as regular segment`,
		);
		await handleSegment(config, dag, segment, stateTracker, segmentResults, scheduler);
		return;
	}

	const trunkResult = segmentResults.get(trunkDepId);
	const branchResult = segmentResults.get(branchDepId);

	const trunkSpec = trunkResult?.currentSpec ?? stateTracker.getSegmentProgress(trunkDepId)?.currentSpec ?? "";
	const branchSpec = branchResult?.currentSpec ?? stateTracker.getSegmentProgress(branchDepId)?.currentSpec ?? "";
	const trunkChangelog =
		trunkResult?.currentChangelog ?? stateTracker.getSegmentProgress(trunkDepId)?.currentChangelog ?? "";
	const branchChangelog =
		branchResult?.currentChangelog ?? stateTracker.getSegmentProgress(branchDepId)?.currentChangelog ?? "";
	const trunkAlliumSha = trunkResult?.tipAlliumSha ?? getLastAlliumSha(stateTracker, trunkDepId) ?? "";
	const branchAlliumSha = branchResult?.tipAlliumSha ?? getLastAlliumSha(stateTracker, branchDepId) ?? "";

	console.error(`[allium-evolve] Merging: ${trunkDepId} + ${branchDepId} at ${mergeSha.slice(0, 8)}`);

	stateTracker.updateSegmentStatus(segment.id, "in-progress");
	await stateTracker.save();

	const mergeResult = await runMerge({
		mergeSha,
		trunkSpec,
		branchSpec,
		trunkChangelog,
		branchChangelog,
		trunkAlliumSha,
		branchAlliumSha,
		trunkSegmentId: trunkDepId,
		branchSegmentId: branchDepId,
		config,
		dag,
	});

	stateTracker.recordMerge({
		mergeSha,
		alliumSha: mergeResult.alliumSha,
		trunkSegmentId: trunkDepId,
		branchSegmentId: branchDepId,
		timestamp: new Date().toISOString(),
	});

	const mergeStep: CompletedStep = {
		originalSha: mergeSha,
		alliumSha: mergeResult.alliumSha,
		model: "opus",
		costUsd: mergeResult.costUsd,
		timestamp: new Date().toISOString(),
	};
	stateTracker.recordStep(segment.id, mergeStep, mergeResult.mergedSpec, mergeResult.mergedChangelog);

	const remainingCommits = segment.commits.slice(1);
	let currentSpec = mergeResult.mergedSpec;
	let currentChangelog = mergeResult.mergedChangelog;
	let tipAlliumSha = mergeResult.alliumSha;

	if (remainingCommits.length > 0) {
		const subSegment: Segment = {
			...segment,
			commits: remainingCommits,
		};

		const subResult = await runSegment({
			segment: subSegment,
			config,
			dag,
			initialSpec: currentSpec,
			initialChangelog: currentChangelog,
			parentAlliumSha: tipAlliumSha,
			onStepComplete: async (step: CompletedStep, spec: string, changelog: string) => {
				stateTracker.recordStep(segment.id, step, spec, changelog);
				await stateTracker.save();
			},
			scheduler,
			stateTracker,
		});

		currentSpec = subResult.currentSpec;
		currentChangelog = subResult.currentChangelog;
		tipAlliumSha = subResult.tipAlliumSha;
	}

	const result: SegmentRunnerResult = {
		completedSteps: [mergeStep],
		currentSpec,
		currentChangelog,
		tipAlliumSha,
	};
	segmentResults.set(segment.id, result);

	stateTracker.updateSegmentStatus(segment.id, "complete");
	await updateRef(config.repoPath, `refs/heads/${config.alliumBranch}`, tipAlliumSha);
	stateTracker.updateBranchHead(tipAlliumSha);
	await stateTracker.save();

	console.error(`[allium-evolve] Completed merge segment: ${segment.id}`);
}

function getLastAlliumSha(stateTracker: StateTracker, segmentId: string): string | undefined {
	const progress = stateTracker.getSegmentProgress(segmentId);
	if (!progress) {
		return undefined;
	}
	const lastStep = progress.completedSteps[progress.completedSteps.length - 1];
	return lastStep?.alliumSha;
}

function getTrunkContextBefore(dag: Map<string, CommitNode>, forkSha: string, count: number): string[] {
	const shas: string[] = [];
	let current = dag.get(forkSha);

	while (current && shas.length < count) {
		shas.unshift(current.sha);
		const firstParent = current.parents[0];
		if (!firstParent) {
			break;
		}
		current = dag.get(firstParent);
	}

	return shas;
}
