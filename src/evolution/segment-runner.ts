import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleContext, assembleModuleSpec } from "../claude/context.js";
import { getModelForStep, type StepType } from "../claude/models.js";
import { type ClaudeResult, invokeClaudeForChunk, invokeClaudeForStep } from "../claude/runner.js";
import type { EvolutionConfig } from "../config.js";
import type { CommitNode, Segment } from "../dag/types.js";
import { createAlliumCommit, updateRef } from "../git/plumbing.js";
import type { SpecStore } from "../spec/store.js";
import type { StateTracker } from "../state/tracker.js";
import type { CompletedStep, SegmentProgress } from "../state/types.js";
import { chunkDiff } from "./diff-chunker.js";
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

		const result =
			context.totalDiffTokens > config.maxDiffTokens
				? await processChunkedStep(
						{ commitSha, stepType, model, windowState, dag, config, currentSpec },
						context.fullDiffs,
					)
				: await processStepFromContext(
						{ commitSha, stepType, model, config },
						context,
					);

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

async function processStepFromContext(
	opts: {
		commitSha: string;
		stepType: StepType;
		model: string;
		config: EvolutionConfig;
	},
	context: { prevSpec: string; contextCommits: string; fullDiffs: string },
): Promise<ClaudeResult> {
	const { stepType, model, config } = opts;

	const templateName = stepType === "initial-commit" ? "initial-commit" : "evolve-step";
	const template = await loadPromptTemplate(templateName);

	const systemPrompt = fillTemplate(template, {
		prevSpec: context.prevSpec,
		contextCommits: context.contextCommits,
		fullDiffs: context.fullDiffs,
	});

	return invokeClaudeForStep({
		systemPrompt,
		userPrompt: "Process the changes and update the specification. Return JSON.",
		model,
		workingDirectory: config.repoPath,
		alliumSkillsPath: config.alliumSkillsPath,
		maxRetries: config.maxParseRetries,
	});
}

async function processChunkedStep(
	opts: {
		commitSha: string;
		stepType: StepType;
		model: string;
		windowState: WindowState;
		dag: Map<string, CommitNode>;
		config: EvolutionConfig;
		currentSpec: string;
	},
	fullDiffs: string,
): Promise<ClaudeResult> {
	const { config, currentSpec } = opts;

	const { chunks } = chunkDiff({
		fullDiff: fullDiffs,
		maxDiffTokens: config.maxDiffTokens,
		ignorePatterns: config.diffIgnorePatterns,
	});

	const chunkResults = await Promise.all(
		chunks.map(async (chunk) => {
			const chunkDiffs = chunk.files.map((f) => f.diff).join("\n");
			return invokeClaudeForChunk({
				systemPrompt: `You are analyzing a subset of changes for Allium specification distillation.\n\nCurrent spec:\n${currentSpec}\n\nChanges (${chunk.groupKey}):\n${chunkDiffs}`,
				userPrompt: "Extract spec changes for this chunk. Return JSON with specPatch and sectionsChanged.",
				model: getModelForStep("chunk-recombine", config),
				workingDirectory: config.repoPath,
				alliumSkillsPath: config.alliumSkillsPath,
			});
		}),
	);

	const specPatches = chunkResults.map((r, i) => `### Chunk: ${chunks[i]!.groupKey}\n${r.specPatch}`).join("\n\n");

	const recombineTemplate = await loadPromptTemplate("recombine-chunks");
	const recombinePrompt = fillTemplate(recombineTemplate, {
		prevSpec: currentSpec,
		specPatches,
	});

	return invokeClaudeForStep({
		systemPrompt: recombinePrompt,
		userPrompt: "Merge all spec patches into a single coherent specification update. Return JSON.",
		model: getModelForStep("chunk-recombine", config),
		workingDirectory: config.repoPath,
		alliumSkillsPath: config.alliumSkillsPath,
		maxRetries: config.maxParseRetries,
	});
}
