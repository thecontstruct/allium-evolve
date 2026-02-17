import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleContext, assembleModuleSpec } from "../claude/context.js";
import { getModelForStep, type StepType } from "../claude/models.js";
import {
	type ClaudeResult,
	invokeClaudeForStep,
	writeContextFiles,
	formatManifest,
} from "../claude/runner.js";
import type { EvolutionConfig } from "../config.js";
import type { CommitNode, Segment } from "../dag/types.js";
import { createAlliumCommit, updateRef } from "../git/plumbing.js";
import type { ShutdownSignal } from "../shutdown.js";
import type { SpecStore } from "../spec/store.js";
import type { StateTracker } from "../state/tracker.js";
import type { CompletedStep, SegmentProgress } from "../state/types.js";
import { advance, createWindow, seedWindow, type WindowState } from "./window.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, "../../prompts");

export interface SegmentRunnerResult {
	completedSteps: CompletedStep[];
	currentSpec: string;
	currentChangelog: string;
	tipAlliumSha: string;
	specStore?: SpecStore;
}

export type StepCallback = (step: CompletedStep, currentSpec: string, currentChangelog: string) => Promise<void>;

async function loadPromptTemplate(name: string): Promise<string> {
	return readFile(resolve(PROMPTS_DIR, `${name}.md`), "utf-8");
}

function fillTemplate(template: string, vars: Record<string, string>): string {
	let result = template;
	for (const [key, value] of Object.entries(vars)) {
		result = result.replaceAll(`{${key}}`, value);
	}
	return result;
}

function isInitialCommit(sha: string, dag: Map<string, CommitNode>): boolean {
	const node = dag.get(sha);
	return node !== undefined && node.parents.length === 0;
}

export async function runSegment(opts: {
	segment: Segment;
	config: EvolutionConfig;
	dag: Map<string, CommitNode>;
	initialSpec: string;
	initialChangelog: string;
	parentAlliumSha: string | null;
	trunkContextShas?: string[];
	onStepComplete?: StepCallback;
	stateTracker?: StateTracker;
	specStore?: SpecStore;
	existingProgress?: SegmentProgress;
	shutdownSignal?: ShutdownSignal;
}): Promise<SegmentRunnerResult> {
	const {
		segment,
		config,
		dag,
		initialSpec,
		initialChangelog,
		parentAlliumSha,
		trunkContextShas,
		onStepComplete,
		stateTracker,
		specStore,
		shutdownSignal,
	} = opts;
	let existingProgress = opts.existingProgress;

	let windowState: WindowState = createWindow(config.windowSize, config.processDepth);

	if (trunkContextShas && trunkContextShas.length > 0) {
		windowState = seedWindow(windowState, trunkContextShas);
	}

	let currentSpec = initialSpec;
	let currentChangelog = initialChangelog;
	let tipAlliumSha = parentAlliumSha ?? "";
	const completedSteps: CompletedStep[] = [];

	if (existingProgress && existingProgress.completedSteps.length > 0) {
		const steps = existingProgress.completedSteps;
		const isValidPrefix = steps.every(
			(step, i) => i < segment.commits.length && step.originalSha === segment.commits[i],
		);
		if (!isValidPrefix) {
			console.error(`[allium-evolve] Step-level resume validation failed for ${segment.id}, reprocessing from scratch`);
			existingProgress = undefined;
			if (stateTracker) {
				stateTracker.resetSegmentProgress(segment.id);
			}
		} else {
			const lastStep = steps[steps.length - 1];
			if (lastStep) {
				tipAlliumSha = lastStep.alliumSha;
			}
			currentSpec = existingProgress.currentSpec;
			currentChangelog = existingProgress.currentChangelog;
			if (specStore) {
				specStore.setMasterSpec(currentSpec);
			}
			console.error(`[allium-evolve] Resuming ${segment.id}: skipping ${steps.length} completed steps`);
		}
	}

	for (const commitSha of segment.commits) {
		let existingStep: CompletedStep | undefined;
		if (existingProgress && existingProgress.completedSteps.length > 0) {
			const stepIndex = completedSteps.length;
			if (stepIndex < existingProgress.completedSteps.length) {
				const expectedStep = existingProgress.completedSteps[stepIndex];
				if (expectedStep && expectedStep.originalSha === commitSha) {
					existingStep = expectedStep;
				} else {
					existingProgress = undefined;
				}
			}
		}

		if (existingStep) {
			windowState = advance(windowState, commitSha);
			completedSteps.push(existingStep);
			continue;
		}

		shutdownSignal?.assertContinue();

		windowState = advance(windowState, commitSha);

		const isInitial = isInitialCommit(commitSha, dag);
		const stepType: StepType = isInitial ? "initial-commit" : "evolve";
		const model = getModelForStep(stepType, config);

		const prevSpecForContext = specStore && specStore.getAllModules().size > 0
			? assembleModuleSpec(specStore, [commitSha])
			: currentSpec;

		const context = await assembleContext({
			windowState,
			dag,
			repoPath: config.repoPath,
			prevSpec: prevSpecForContext,
		});

		const result = await processStep({
			stepType,
			model,
			config,
			currentSpec: prevSpecForContext,
			contextCommits: context.contextCommits,
			fullDiffs: context.fullDiffs,
		});

		currentSpec = result.spec;
		if (specStore) {
			specStore.setMasterSpec(result.spec);
		}
		const changelogEntry = `\n${result.changelog}\n`;
		currentChangelog += changelogEntry;

		const node = dag.get(commitSha);
		const originalMessage = node?.message ?? "";
		const windowCommits = windowState.commits;
		const commitMessage = [
			`allium: ${result.commitMessage}`,
			"",
			`Original: ${commitSha} "${originalMessage}"`,
			`Window: ${windowCommits[0]?.slice(0, 8) ?? ""}..${windowCommits[windowCommits.length - 1]?.slice(0, 8) ?? ""}`,
			`Model: ${model}`,
		].join("\n");

		const parentShas = tipAlliumSha ? [tipAlliumSha] : [];
		const alliumSha = await createAlliumCommit({
			repoPath: config.repoPath,
			originalSha: commitSha,
			parentShas,
			specContent: specStore ? undefined : currentSpec,
			specFiles: specStore ? specStore.toFileMap() : undefined,
			changelogContent: currentChangelog,
			commitMessage,
			segmentId: segment.id,
		});

		if (config.parallelBranches && segment.type !== "trunk") {
			await updateRef(config.repoPath, `refs/allium/segments/${segment.id}`, alliumSha);
		}

		tipAlliumSha = alliumSha;

		const step: CompletedStep = {
			originalSha: commitSha,
			alliumSha,
			model,
			costUsd: result.costUsd,
			timestamp: new Date().toISOString(),
		};
		completedSteps.push(step);

		if (onStepComplete) {
			await onStepComplete(step, currentSpec, currentChangelog);
		}
	}

	return {
		completedSteps,
		currentSpec,
		currentChangelog,
		tipAlliumSha,
		specStore,
	};
}

async function processStep(opts: {
	stepType: StepType;
	model: string;
	config: EvolutionConfig;
	currentSpec: string;
	contextCommits: string;
	fullDiffs: string;
}): Promise<ClaudeResult> {
	const { stepType, model, config, currentSpec, contextCommits, fullDiffs } = opts;

	const contextFiles: Record<string, string> = {
		"current-spec.allium": currentSpec,
		"changes.diff": fullDiffs,
	};
	if (contextCommits) {
		contextFiles["context-commits.md"] = contextCommits;
	}

	const ctx = await writeContextFiles(config.repoPath, contextFiles);

	try {
		const templateName = stepType === "initial-commit" ? "initial-commit" : "evolve-step";
		const template = await loadPromptTemplate(templateName);

		const systemPrompt = fillTemplate(template, {
			contextManifest: formatManifest(ctx.manifest),
		});

		return await invokeClaudeForStep({
			systemPrompt,
			userPrompt: "Read the context files, process the changes, and update the specification. Return JSON.",
			model,
			workingDirectory: config.repoPath,
			alliumSkillsPath: config.alliumSkillsPath,
			maxRetries: config.maxParseRetries,
		});
	} finally {
		await ctx.cleanup();
	}
}
