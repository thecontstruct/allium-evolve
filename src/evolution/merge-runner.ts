import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getModelForStep } from "../claude/models.js";
import {
	invokeClaudeForStep,
	writeContextFiles,
	formatManifest,
} from "../claude/runner.js";
import type { EvolutionConfig } from "../config.js";
import type { CommitNode } from "../dag/types.js";
import { formatOriginalLine } from "../git/commit-metadata.js";
import { getDiff, getDiffstat } from "../git/diff.js";
import { createAlliumCommit } from "../git/plumbing.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, "../../prompts");

export interface MergeRunnerResult {
	alliumSha: string;
	mergedSpec: string;
	mergedChangelog: string;
	costUsd: number;
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

export function extractUniqueEntries(trunkChangelog: string, branchChangelog: string): string {
	const trunkShas = new Set<string>();
	const shaPattern = /^## ([a-f0-9]{7,8})/gm;
	for (const match of trunkChangelog.matchAll(shaPattern)) {
		trunkShas.add(match[1]!);
	}

	const entries = branchChangelog.split(/(?=\n## )/);
	const unique = entries.filter((entry) => {
		const shaMatch = entry.match(/## ([a-f0-9]{7,8})/);
		return shaMatch && !trunkShas.has(shaMatch[1]!);
	});

	return unique.join("");
}

export async function runMerge(opts: {
	mergeSha: string;
	trunkSpec: string;
	branchSpec: string;
	trunkChangelog: string;
	branchChangelog: string;
	trunkAlliumSha: string;
	branchAlliumSha: string;
	trunkSegmentId: string;
	branchSegmentId: string;
	config: EvolutionConfig;
	dag: Map<string, CommitNode>;
}): Promise<MergeRunnerResult> {
	const {
		mergeSha,
		trunkSpec,
		branchSpec,
		trunkChangelog,
		branchChangelog,
		trunkAlliumSha,
		branchAlliumSha,
		trunkSegmentId,
		branchSegmentId,
		config,
		dag,
	} = opts;

	const node = dag.get(mergeSha);
	const parentSha = node?.parents[0] ?? null;
	const mergeDiff = await getDiff(config.repoPath, parentSha, mergeSha);
	const mergeDiffstat = await getDiffstat(config.repoPath, parentSha, mergeSha);

	const contextFiles: Record<string, string> = {
		"trunk-spec.allium": trunkSpec,
		"branch-spec.allium": branchSpec,
		"merge.diff": mergeDiff,
		"merge.diffstat": mergeDiffstat,
	};

	const ctx = await writeContextFiles(config.repoPath, contextFiles);

	try {
		const template = await loadPromptTemplate("merge-specs");
		const systemPrompt = fillTemplate(template, {
			contextManifest: formatManifest(ctx.manifest),
		});

		const model = getModelForStep("merge", config);
		const result = await invokeClaudeForStep({
			systemPrompt,
			userPrompt: "Read the context files, reconcile the two specifications, and produce a unified version. Return JSON.",
			model,
			workingDirectory: config.repoPath,
			alliumSkillsPath: config.alliumSkillsPath,
			maxRetries: config.maxParseRetries,
		});

		const uniqueBranchEntries = extractUniqueEntries(trunkChangelog, branchChangelog);
		const mergedChangelog =
			trunkChangelog + uniqueBranchEntries + `\n## ${mergeSha.slice(0, 8)} (merge)\n\n${result.changelog}\n`;

		const originalMessage = node?.message ?? "";
		const commitMessage = [
			`allium: ${result.commitMessage}`,
			"",
			formatOriginalLine(mergeSha, originalMessage),
			`Merge: ${trunkSegmentId} + ${branchSegmentId}`,
			`Model: ${model}`,
		].join("\n");

		const alliumSha = await createAlliumCommit({
			repoPath: config.repoPath,
			originalSha: mergeSha,
			parentShas: [trunkAlliumSha, branchAlliumSha],
			specContent: result.spec,
			changelogContent: mergedChangelog,
			commitMessage,
		});

		return {
			alliumSha,
			mergedSpec: result.spec,
			mergedChangelog,
			costUsd: result.costUsd,
		};
	} finally {
		await ctx.cleanup();
	}
}
