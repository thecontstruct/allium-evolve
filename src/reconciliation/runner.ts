import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ReconcileChunkResult,
	ReconciliationFinding,
} from "../claude/runner.js";
import {
	invokeClaudeForReconcileChunk,
	invokeClaudeForReconcileCombine,
} from "../claude/runner.js";
import type { EvolutionConfig } from "../config.js";
import { estimateTokens } from "../utils/tokens.js";
import type { SourceChunk, SourceReadResult } from "./source-reader.js";
import { readDiff, readTree } from "./source-reader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, "../../prompts");

export interface ReconciliationResult {
	updatedSpec: string;
	changelog: string;
	commitMessage: string;
	findings: ReconciliationFinding[];
	skippedFiles: string[];
	costUsd: number;
	skipped: boolean;
}

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

function formatSourceChunk(chunk: SourceChunk): string {
	return chunk.files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
}

function formatFindings(findings: ReconciliationFinding[]): string {
	return findings
		.map(
			(f, i) =>
				`### Finding ${i + 1} (${f.type})\n` +
				`Section: ${f.specSection}\n` +
				`${f.description}\n` +
				`Sources: ${f.sourcePaths.join(", ")}`,
		)
		.join("\n\n");
}

async function analyzeChunks(
	chunks: SourceChunk[],
	currentSpec: string,
	skippedFiles: string[],
	config: EvolutionConfig,
): Promise<{ findings: ReconciliationFinding[]; totalCost: number }> {
	const template = await loadPromptTemplate("reconcile-chunk");
	const model = config.defaultModel;
	const allFindings: ReconciliationFinding[] = [];
	let totalCost = 0;

	const skippedFilesSection =
		skippedFiles.length > 0
			? `## Skipped Files (excluded from analysis — do NOT treat as removed)\n\n${skippedFiles.join("\n")}`
			: "";

	const concurrency = config.reconciliation.maxConcurrency;
	for (let i = 0; i < chunks.length; i += concurrency) {
		const batch = chunks.slice(i, i + concurrency);
		const results = await Promise.all(
			batch.map(async (chunk): Promise<ReconcileChunkResult> => {
				const systemPrompt = fillTemplate(template, {
					currentSpec,
					groupKey: chunk.groupKey,
					sourceContent: formatSourceChunk(chunk),
					skippedFilesSection,
				});

				return invokeClaudeForReconcileChunk({
					systemPrompt,
					userPrompt:
						"Analyze this source package against the spec. Identify missing rules, behaviors, and obsolete references. Return JSON.",
					model,
					workingDirectory: config.repoPath,
					alliumSkillsPath: config.alliumSkillsPath,
				});
			}),
		);

		for (const result of results) {
			allFindings.push(...result.findings);
			totalCost += result.costUsd;
		}
	}

	return { findings: allFindings, totalCost };
}

async function combineFindings(
	currentSpec: string,
	findings: ReconciliationFinding[],
	config: EvolutionConfig,
): Promise<{ updatedSpec: string; changelog: string; commitMessage: string; costUsd: number }> {
	const template = await loadPromptTemplate("reconcile-combine");
	const model = config.reconciliation.model ?? config.opusModel;

	const findingsText = formatFindings(findings);
	const findingsTokens = estimateTokens(findingsText);

	if (findingsTokens <= config.maxDiffTokens) {
		const systemPrompt = fillTemplate(template, {
			currentSpec,
			findings: findingsText,
			batchContext: "",
		});

		const result = await invokeClaudeForReconcileCombine({
			systemPrompt,
			userPrompt: "Integrate findings into the specification. Return JSON.",
			model,
			workingDirectory: config.repoPath,
			alliumSkillsPath: config.alliumSkillsPath,
			maxRetries: config.maxParseRetries,
		});

		return {
			updatedSpec: result.spec,
			changelog: result.changelog,
			commitMessage: result.commitMessage,
			costUsd: result.costUsd,
		};
	}

	const additions = findings.filter((f) => f.type === "addition" || f.type === "modification");
	const removals = findings.filter((f) => f.type === "removal");
	const sorted = [...additions, ...removals];

	const batches: ReconciliationFinding[][] = [];
	let currentBatch: ReconciliationFinding[] = [];
	let currentTokens = 0;

	for (const finding of sorted) {
		const findingTokens = estimateTokens(formatFindings([finding]));
		if (currentTokens + findingTokens > config.maxDiffTokens && currentBatch.length > 0) {
			batches.push(currentBatch);
			currentBatch = [];
			currentTokens = 0;
		}
		currentBatch.push(finding);
		currentTokens += findingTokens;
	}
	if (currentBatch.length > 0) {
		batches.push(currentBatch);
	}

	let workingSpec = currentSpec;
	let totalCost = 0;
	let lastChangelog = "";
	let lastCommitMessage = "";

	for (let i = 0; i < batches.length; i++) {
		const batch = batches[i]!;
		const remaining = batches.slice(i + 1);
		const remainingAdditions = remaining.flat().filter((f) => f.type === "addition" || f.type === "modification").length;
		const remainingRemovals = remaining.flat().filter((f) => f.type === "removal").length;

		const batchContext =
			remaining.length > 0
				? `Note: ${remaining.length} more batches follow with ${remainingAdditions} additions/modifications and ${remainingRemovals} removals.`
				: "";

		const systemPrompt = fillTemplate(template, {
			currentSpec: workingSpec,
			findings: formatFindings(batch),
			batchContext,
		});

		const result = await invokeClaudeForReconcileCombine({
			systemPrompt,
			userPrompt: `Integrate batch ${i + 1}/${batches.length} findings into the specification. Return JSON.`,
			model,
			workingDirectory: config.repoPath,
			alliumSkillsPath: config.alliumSkillsPath,
			maxRetries: config.maxParseRetries,
		});

		workingSpec = result.spec;
		totalCost += result.costUsd;
		lastChangelog = result.changelog;
		lastCommitMessage = result.commitMessage;
	}

	return {
		updatedSpec: workingSpec,
		changelog: lastChangelog,
		commitMessage: lastCommitMessage,
		costUsd: totalCost,
	};
}

export async function runReconciliation(opts: {
	currentSpec: string;
	commitSha: string;
	config: EvolutionConfig;
	lastReconciliationSha: string | undefined;
}): Promise<ReconciliationResult> {
	const { currentSpec, commitSha, config, lastReconciliationSha } = opts;

	let sourceResult: SourceReadResult | null = null;

	if (lastReconciliationSha) {
		sourceResult = await readDiff(
			config.repoPath,
			lastReconciliationSha,
			commitSha,
			config.reconciliation,
			config.maxDiffTokens,
		);

		if (!sourceResult) {
			console.error("[reconciliation] Diff too large, falling back to full tree scan");
			sourceResult = await readTree(config.repoPath, commitSha, config.reconciliation, config.maxDiffTokens);
		}
	} else {
		sourceResult = await readTree(config.repoPath, commitSha, config.reconciliation, config.maxDiffTokens);
	}

	if (sourceResult.chunks.length === 0) {
		console.error("[reconciliation] No source chunks to analyze, skipping");
		return {
			updatedSpec: currentSpec,
			changelog: "",
			commitMessage: "",
			findings: [],
			skippedFiles: sourceResult.skippedFiles,
			costUsd: 0,
			skipped: true,
		};
	}

	console.error(
		`[reconciliation] Analyzing ${sourceResult.chunks.length} source chunks ` +
			`(${sourceResult.skippedFiles.length} files skipped)`,
	);

	const { findings, totalCost: analysisCost } = await analyzeChunks(
		sourceResult.chunks,
		currentSpec,
		sourceResult.skippedFiles,
		config,
	);

	if (findings.length === 0) {
		console.error("[reconciliation] No findings, spec is up to date");
		return {
			updatedSpec: currentSpec,
			changelog: "",
			commitMessage: "",
			findings: [],
			skippedFiles: sourceResult.skippedFiles,
			costUsd: analysisCost,
			skipped: false,
		};
	}

	console.error(`[reconciliation] Found ${findings.length} findings, combining into spec`);

	const combined = await combineFindings(currentSpec, findings, config);

	return {
		updatedSpec: combined.updatedSpec,
		changelog: combined.changelog,
		commitMessage: combined.commitMessage,
		findings,
		skippedFiles: sourceResult.skippedFiles,
		costUsd: analysisCost + combined.costUsd,
		skipped: false,
	};
}
