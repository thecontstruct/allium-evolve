import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReconciliationFinding } from "../claude/runner.js";
import {
	invokeClaudeForStep,
	writeContextFiles,
	formatManifest,
} from "../claude/runner.js";
import type { EvolutionConfig } from "../config.js";
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

function buildSourceContextFiles(chunks: SourceChunk[]): Record<string, string> {
	const files: Record<string, string> = {};
	for (const chunk of chunks) {
		const content = chunk.files
			.map((f) => `--- ${f.path} ---\n${f.content}`)
			.join("\n\n");
		const safeName = chunk.groupKey.replace(/\//g, "--");
		files[`source/${safeName}.txt`] = content;
	}
	return files;
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

	const contextFiles: Record<string, string> = {
		"current-spec.allium": currentSpec,
		...buildSourceContextFiles(sourceResult.chunks),
	};

	if (sourceResult.skippedFiles.length > 0) {
		contextFiles["skipped-files.txt"] = sourceResult.skippedFiles.join("\n");
	}

	const ctx = await writeContextFiles(config.repoPath, contextFiles);

	try {
		const template = await loadPromptTemplate("reconcile-spec");
		const model = config.reconciliation.model ?? config.opusModel;

		const systemPrompt = fillTemplate(template, {
			contextManifest: formatManifest(ctx.manifest),
			chunkCount: String(sourceResult.chunks.length),
			skippedCount: String(sourceResult.skippedFiles.length),
		});

		const result = await invokeClaudeForStep({
			systemPrompt,
			userPrompt:
				"Read the context files, analyze the source against the spec, and produce an updated specification. Return JSON.",
			model,
			workingDirectory: config.repoPath,
			alliumSkillsPath: config.alliumSkillsPath,
			maxRetries: config.maxParseRetries,
			maxTurns: 150,
		});

		return {
			updatedSpec: result.spec,
			changelog: result.changelog,
			commitMessage: result.commitMessage,
			findings: [],
			skippedFiles: sourceResult.skippedFiles,
			costUsd: result.costUsd,
			skipped: false,
		};
	} finally {
		await ctx.cleanup();
	}
}
