import type { EvolutionConfig } from "../config.js";
import { collectAncestors } from "../dag/ancestors.js";
import { buildDag } from "../dag/builder.js";
import { decompose } from "../dag/segments.js";
import { identifyTrunk } from "../dag/trunk.js";
import type { CommitNode, Segment } from "../dag/types.js";
import { readChangelogFromCommit, readSpecFromCommit } from "../git/read-spec.js";
import { updateRef } from "../git/plumbing.js";
import type { ShutdownSignal } from "../shutdown.js";
import { StateTracker } from "../state/tracker.js";
import { confirmContinue } from "../utils/confirm.js";
import type { CompletedStep, SegmentProgress } from "../state/types.js";
import { exec } from "../utils/exec.js";
import { resolveFromAlliumBranch } from "./seed-resolver.js";
import { runMerge } from "./merge-runner.js";
import { runSegment, type SegmentRunnerResult } from "./segment-runner.js";

export type ResumeMode = "fresh" | "state-file" | "allium-branch";

export interface ResumeInfo {
	mode: ResumeMode;
	totalCommits: number;
	segmentCount: number;
	completedSteps?: number;
	remainingSteps?: number;
	tipAlliumSha?: string;
	startAfterSha?: string;
	lastProcessedMessage?: string | null;
	commitsBeyondAnchor?: number;
	costSoFar?: number;
}

export interface SetupResult {
	dag: Map<string, CommitNode>;
	segments: Segment[];
	rootCommit: string;
	stateTracker: StateTracker;
	isResume: boolean;
	resumeInfo: ResumeInfo;
}

export async function setupEvolution(config: EvolutionConfig): Promise<SetupResult> {
	console.error(`[allium-evolve] Starting setup for ${config.repoPath}`);
	console.error(`[allium-evolve] Target ref: ${config.targetRef}`);

	const dag = await buildDag(config.repoPath, config.targetRef);
	if (dag.size === 0) {
		throw new Error(
			`No commits found for ref '${config.targetRef}'. Verify the repository has commits and the ref exists.`,
		);
	}

	await identifyTrunk(dag, config.repoPath, config.targetRef);
	const segments = decompose(dag);
	if (segments.length === 0) {
		throw new Error("DAG produced 0 segments — nothing to process.");
	}

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
	let isResume: boolean;
	let resumeInfo: ResumeInfo;

	const totalSteps = segments.reduce((sum, s) => sum + s.commits.length, 0);

	isResume = await stateTracker.load();
	if (isResume) {
		const state = stateTracker.getState();
		if (!dag.has(state.rootCommit)) {
			throw new Error(
				"State file references commits not in the current DAG (possible history rewrite). Delete the state file to restart, or restore the original history.",
			);
		}
		for (const seg of segments) {
			const progress = state.segmentProgress[seg.id];
			if (!progress || progress.completedSteps.length === 0) continue;
			for (const step of progress.completedSteps) {
				if (!dag.has(step.originalSha)) {
					throw new Error(
						"State file references commits not in the current DAG (possible history rewrite). Delete the state file to restart, or restore the original history.",
					);
				}
			}
		}
		console.error("[allium-evolve] Resumed from existing state");
		resumeInfo = {
			mode: "state-file",
			totalCommits: dag.size,
			segmentCount: segments.length,
			completedSteps: state.totalSteps,
			remainingSteps: totalSteps - state.totalSteps,
			costSoFar: state.totalCostUsd,
		};
	} else {
		const resolved = await resolveFromAlliumBranch(config.repoPath, config.alliumBranch);
		if (resolved) {
			const { tipAlliumSha, startAfterSha, shaMap, commitsBeyondAnchor, lastProcessedMessage } = resolved;
			if (!dag.has(startAfterSha)) {
				throw new Error(
					`Allium branch '${config.alliumBranch}' references commit ${startAfterSha.slice(0, 8)} which is not in the current DAG. Restore the missing commits, delete the allium branch to start fresh, or rebase the allium branch to remove commits referencing dropped originals.`,
				);
			}
			const { stdout: tipRef } = await exec(`git rev-parse ${config.targetRef}`, { cwd: config.repoPath });
			const tipSha = tipRef.trim();
			if (tipSha === startAfterSha) {
				throw new Error(
					`Allium branch is already at the tip of ${config.targetRef}. No new commits to process.`,
				);
			}
			stateTracker.initState(config, segments, rootCommit);
			stateTracker.setShaMap(shaMap);
			stateTracker.updateBranchHead(tipAlliumSha);
			const ancestorSet = collectAncestors(dag, startAfterSha);
			for (const segment of segments) {
				const prefixLength = segment.commits.filter((c) => ancestorSet.has(c)).length;
				if (prefixLength === 0) continue;
				if (prefixLength === segment.commits.length) {
					const segTipSha = segment.commits[segment.commits.length - 1]!;
					const segTipAlliumSha = shaMap[segTipSha];
					if (!segTipAlliumSha) {
						throw new Error(
							`Cannot seed segment '${segment.id}': no allium SHA found for original commit ${segTipSha.slice(0, 8)}. The corresponding allium commit may have been manually edited or lacks an 'Original:' tag. Fix the allium branch commit message for ${segTipSha.slice(0, 8)}.`,
						);
					}
					const currentSpec = await readSpecFromCommit(config.repoPath, segTipAlliumSha);
					const currentChangelog = await readChangelogFromCommit(config.repoPath, segTipAlliumSha);
					const tipStep: CompletedStep = {
						originalSha: segTipSha,
						alliumSha: segTipAlliumSha,
						model: "seeded",
						costUsd: 0,
						timestamp: new Date().toISOString(),
					};
					stateTracker.seedSegmentProgress(
						segment.id,
						{
							status: "complete",
							completedSteps: [tipStep],
							currentSpec,
							currentChangelog,
						},
						segment.commits.length,
					);
				} else {
					const prefixCommits = segment.commits.slice(0, prefixLength);
					const completedSteps: CompletedStep[] = [];
					for (const commitSha of prefixCommits) {
						const alliumSha = shaMap[commitSha];
						if (!alliumSha) {
							throw new Error(
								`Cannot seed partial segment '${segment.id}': no allium SHA found for original commit ${commitSha.slice(0, 8)}. The corresponding allium commit may have been manually edited or lacks an 'Original:' tag. Fix the allium branch commit message for ${commitSha.slice(0, 8)}.`,
							);
						}
						completedSteps.push({
							originalSha: commitSha,
							alliumSha,
							model: "seeded",
							costUsd: 0,
							timestamp: new Date().toISOString(),
						});
					}
					const lastAlliumSha = completedSteps[completedSteps.length - 1]!.alliumSha;
					const currentSpec = await readSpecFromCommit(config.repoPath, lastAlliumSha);
					const currentChangelog = await readChangelogFromCommit(config.repoPath, lastAlliumSha);
					stateTracker.seedSegmentProgress(
						segment.id,
						{
							status: "in-progress",
							completedSteps,
							currentSpec,
							currentChangelog,
						},
						prefixLength,
					);
				}
			}
			isResume = true;
			console.error("[allium-evolve] Seeded from allium branch");
			const completedSteps = stateTracker.getState().totalSteps;
			resumeInfo = {
				mode: "allium-branch",
				totalCommits: dag.size,
				segmentCount: segments.length,
				completedSteps,
				remainingSteps: totalSteps - completedSteps,
				tipAlliumSha,
				startAfterSha,
				lastProcessedMessage,
				commitsBeyondAnchor,
				costSoFar: 0,
			};
		} else {
			stateTracker.initState(config, segments, rootCommit);
			resumeInfo = {
				mode: "fresh",
				totalCommits: dag.size,
				segmentCount: segments.length,
			};
		}
	}

	return { dag, segments, rootCommit, stateTracker, isResume, resumeInfo };
}

function formatResumeMessage(resumeInfo: ResumeInfo, alliumBranch: string): string {
	const lines: string[] = [];
	if (resumeInfo.mode === "allium-branch") {
		lines.push(`[allium-evolve] Resume detected from allium branch '${alliumBranch}'`);
		if (resumeInfo.lastProcessedMessage) {
			lines.push(`  Last processed: ${resumeInfo.startAfterSha?.slice(0, 8)} "${resumeInfo.lastProcessedMessage}"`);
		}
		lines.push(`  Allium tip:     ${resumeInfo.tipAlliumSha?.slice(0, 8)}${resumeInfo.commitsBeyondAnchor ? ` (${resumeInfo.commitsBeyondAnchor} commits ahead of last Original: tag)` : ""}`);
		lines.push(`  Commits in DAG: ${resumeInfo.totalCommits}`);
		lines.push(`  Already done:   ${resumeInfo.completedSteps}`);
		lines.push(`  Remaining:      ${resumeInfo.remainingSteps}`);
	} else if (resumeInfo.mode === "state-file") {
		lines.push("[allium-evolve] Resume detected from state file");
		const totalSteps =
			(resumeInfo.completedSteps ?? 0) + (resumeInfo.remainingSteps ?? 0);
		lines.push(`  Completed:  ${resumeInfo.completedSteps} / ${totalSteps} steps`);
		if (resumeInfo.costSoFar !== undefined && resumeInfo.costSoFar > 0) {
			lines.push(`  Cost so far: $${resumeInfo.costSoFar.toFixed(4)}`);
		}
	} else {
		lines.push("[allium-evolve] Fresh start — no allium branch or state file found");
		lines.push(`  Commits in DAG: ${resumeInfo.totalCommits}`);
		lines.push(`  Segments:       ${resumeInfo.segmentCount}`);
	}
	return lines.join("\n");
}

export async function runEvolution(config: EvolutionConfig, shutdownSignal?: ShutdownSignal): Promise<void> {
	console.error(`[allium-evolve] Parallel branches: ${config.parallelBranches}`);

	const { dag, segments, stateTracker, resumeInfo } = await setupEvolution(config);

	const message = formatResumeMessage(resumeInfo, config.alliumBranch);
	console.error(message);

	if (!config.autoConfirm) {
		let confirmed: boolean;
		try {
			confirmed = await confirmContinue("Continue?");
		} catch (err) {
			if (err instanceof Error && err.message.includes("Non-interactive terminal")) {
				console.error("[allium-evolve] Cannot prompt for confirmation in non-interactive mode. Use --yes / -y to skip.");
				return;
			}
			throw err;
		}
		if (!confirmed) {
			console.error("[allium-evolve] Aborted by user.");
			return;
		}
	}

	await stateTracker.save();

	const segmentResults = new Map<string, SegmentRunnerResult>();
	for (const seg of segments) {
		const progress = stateTracker.getSegmentProgress(seg.id);
		if (progress?.status === "complete" && progress.completedSteps.length > 0) {
			const lastStep = progress.completedSteps[progress.completedSteps.length - 1]!;
			segmentResults.set(seg.id, {
				currentSpec: progress.currentSpec,
				currentChangelog: progress.currentChangelog,
				tipAlliumSha: lastStep.alliumSha,
				completedSteps: progress.completedSteps,
			});
		}
	}

	if (config.parallelBranches) {
		await runParallel(config, dag, segments, stateTracker, segmentResults, shutdownSignal);
	} else {
		await runSequential(config, dag, segments, stateTracker, segmentResults, shutdownSignal);
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
	shutdownSignal?: ShutdownSignal,
): Promise<void> {
	for (const segment of segments) {
		shutdownSignal?.assertContinue();
		await processSegmentOrMerge(config, dag, segment, segments, stateTracker, segmentResults, shutdownSignal);
	}
}

async function runParallel(
	config: EvolutionConfig,
	dag: Map<string, CommitNode>,
	segments: Segment[],
	stateTracker: StateTracker,
	segmentResults: Map<string, SegmentRunnerResult>,
	shutdownSignal?: ShutdownSignal,
): Promise<void> {
	const completed = new Set<string>();
	const inProgress = new Map<string, Promise<void>>();

	function isReady(seg: Segment): boolean {
		return seg.dependsOn.every((dep) => completed.has(dep));
	}

	async function processAndTrack(seg: Segment): Promise<void> {
		try {
			await processSegmentOrMerge(config, dag, seg, segments, stateTracker, segmentResults, shutdownSignal);
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
		if (shutdownSignal?.requested) {
			if (inProgress.size > 0) {
				await Promise.allSettled(inProgress.values());
			}
			shutdownSignal.assertContinue();
		}

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
	shutdownSignal?: ShutdownSignal,
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
		await handleMergeAndSegment(config, dag, segment, allSegments, stateTracker, segmentResults, shutdownSignal);
	} else {
		await handleSegment(config, dag, segment, stateTracker, segmentResults, shutdownSignal);
	}
}

async function handleSegment(
	config: EvolutionConfig,
	dag: Map<string, CommitNode>,
	segment: Segment,
	stateTracker: StateTracker,
	segmentResults: Map<string, SegmentRunnerResult>,
	shutdownSignal?: ShutdownSignal,
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

	const existingProgress = stateTracker.getSegmentProgress(segment.id);

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
		stateTracker,
		existingProgress,
		shutdownSignal,
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
	shutdownSignal?: ShutdownSignal,
): Promise<void> {
	const mergeSha = segment.commits[0]!;

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
		await handleSegment(config, dag, segment, stateTracker, segmentResults, shutdownSignal);
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

	const segmentProgress = stateTracker.getSegmentProgress(segment.id);
	const remainingCommits = segment.commits.slice(1);
	let filteredProgress: SegmentProgress | undefined;
	let mergeStep: CompletedStep | undefined;
	let currentSpec: string;
	let currentChangelog: string;
	let tipAlliumSha: string;

	if (segmentProgress && segmentProgress.completedSteps.length > 0) {
		const steps = segmentProgress.completedSteps;
		const mergeStepCompleted = steps[0]?.originalSha === mergeSha;

		if (mergeStepCompleted) {
			const postMergeSteps = steps.slice(1);
			const isValidPostMergePrefix = postMergeSteps.every(
				(step, i) => i < remainingCommits.length && step.originalSha === remainingCommits[i],
			);

			if (isValidPostMergePrefix) {
				mergeStep = steps[0];
				tipAlliumSha = mergeStep!.alliumSha;
				currentSpec = segmentProgress.currentSpec;
				currentChangelog = segmentProgress.currentChangelog;

				filteredProgress = {
					...segmentProgress,
					completedSteps: postMergeSteps,
				};

				console.error(
					`[allium-evolve] Resuming merge segment ${segment.id}: skipping merge + ${postMergeSteps.length} post-merge steps`,
				);
			}
		}

		if (!filteredProgress) {
			console.error(`[allium-evolve] Merge resume validation failed for ${segment.id}, reprocessing`);
			stateTracker.resetSegmentProgress(segment.id);
		}
	}

	if (!filteredProgress) {
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

		mergeStep = {
			originalSha: mergeSha,
			alliumSha: mergeResult.alliumSha,
			model: "opus",
			costUsd: mergeResult.costUsd,
			timestamp: new Date().toISOString(),
		};
		stateTracker.recordStep(segment.id, mergeStep, mergeResult.mergedSpec, mergeResult.mergedChangelog);

		tipAlliumSha = mergeResult.alliumSha;
		currentSpec = mergeResult.mergedSpec;
		currentChangelog = mergeResult.mergedChangelog;
	}

	if (remainingCommits.length > 0) {
		shutdownSignal?.assertContinue();

		const subSegment: Segment = {
			...segment,
			commits: remainingCommits,
		};

		const subResult = await runSegment({
			segment: subSegment,
			config,
			dag,
			initialSpec: currentSpec!,
			initialChangelog: currentChangelog!,
			parentAlliumSha: tipAlliumSha!,
			onStepComplete: async (step: CompletedStep, spec: string, changelog: string) => {
				stateTracker.recordStep(segment.id, step, spec, changelog);
				await stateTracker.save();
			},
			stateTracker,
			existingProgress: filteredProgress,
			shutdownSignal,
		});

		currentSpec = subResult.currentSpec;
		currentChangelog = subResult.currentChangelog;
		tipAlliumSha = subResult.tipAlliumSha;
	}

	const result: SegmentRunnerResult = {
		completedSteps: [mergeStep!],
		currentSpec: currentSpec!,
		currentChangelog: currentChangelog!,
		tipAlliumSha: tipAlliumSha!,
	};
	segmentResults.set(segment.id, result);

	stateTracker.updateSegmentStatus(segment.id, "complete");
	await updateRef(config.repoPath, `refs/heads/${config.alliumBranch}`, tipAlliumSha!);
	stateTracker.updateBranchHead(tipAlliumSha!);
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
