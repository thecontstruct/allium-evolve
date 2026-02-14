import type { CommitNode } from "../dag/types.js";
import type { WindowState } from "../evolution/window.js";
import { getContextShas, getFullDiffShas } from "../evolution/window.js";
import { getDiff } from "../git/diff.js";
import { estimateTokens } from "../utils/tokens.js";

export interface AssembledContext {
	prevSpec: string;
	contextCommits: string;
	fullDiffs: string;
	totalDiffTokens: number;
}

export async function assembleContext(opts: {
	windowState: WindowState;
	dag: Map<string, CommitNode>;
	repoPath: string;
	prevSpec: string;
}): Promise<AssembledContext> {
	const { windowState, dag, repoPath, prevSpec } = opts;

	const contextShas = getContextShas(windowState);
	const contextLines: string[] = [];
	for (const sha of contextShas) {
		const node = dag.get(sha);
		const message = node?.message ?? "unknown";
		contextLines.push(`### ${sha.slice(0, 8)} — ${message}`);
	}
	const contextCommits = contextLines.join("\n");

	const fullDiffShas = getFullDiffShas(windowState);
	const diffLines: string[] = [];
	for (const sha of fullDiffShas) {
		const node = dag.get(sha);
		const message = node?.message ?? "unknown";
		const parentSha = node?.parents[0] ?? null;
		const diff = await getDiff(repoPath, parentSha, sha);
		diffLines.push(`### ${sha.slice(0, 8)} — ${message}\n\`\`\`diff\n${diff}\n\`\`\``);
	}
	const fullDiffs = diffLines.join("\n");

	const totalDiffTokens = estimateTokens(fullDiffs);

	return {
		prevSpec,
		contextCommits,
		fullDiffs,
		totalDiffTokens,
	};
}
