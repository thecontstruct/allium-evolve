import type { CommitNode } from "../dag/types.js";
import type { WindowState } from "../evolution/window.js";
import { getContextShas, getFullDiffShas } from "../evolution/window.js";
import { getDiff } from "../git/diff.js";
import type { SpecStore } from "../spec/store.js";
import { estimateTokens } from "../utils/tokens.js";

export interface AssembledContext {
	prevSpec: string;
	contextCommits: string;
	fullDiffs: string;
	totalDiffTokens: number;
	changedPaths: string[];
}

function extractChangedPaths(diffText: string): string[] {
	const paths: string[] = [];
	const pattern = /^diff --git a\/\S+ b\/(\S+)/gm;
	for (const match of diffText.matchAll(pattern)) {
		if (match[1]) {
			paths.push(match[1]);
		}
	}
	return paths;
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
	const allChangedPaths: string[] = [];
	for (const sha of fullDiffShas) {
		const node = dag.get(sha);
		const message = node?.message ?? "unknown";
		const parentSha = node?.parents[0] ?? null;
		const diff = await getDiff(repoPath, parentSha, sha);
		diffLines.push(`### ${sha.slice(0, 8)} — ${message}\n\`\`\`diff\n${diff}\n\`\`\``);
		allChangedPaths.push(...extractChangedPaths(diff));
	}
	const fullDiffs = diffLines.join("\n");

	const totalDiffTokens = estimateTokens(fullDiffs);

	return {
		prevSpec,
		contextCommits,
		fullDiffs,
		totalDiffTokens,
		changedPaths: allChangedPaths,
	};
}

export function assembleModuleSpec(specStore: SpecStore, changedPaths: string[]): string {
	const { master, modules } = specStore.getRelevantSpecs(changedPaths);

	const parts: string[] = [];
	parts.push("## Master Specification\n");
	parts.push(master);

	if (modules.size > 0) {
		parts.push("\n## Relevant Module Specifications\n");
		for (const [modulePath, content] of modules) {
			parts.push(`### Module: ${modulePath}\n`);
			parts.push(content);
			parts.push("");
		}
	}

	return parts.join("\n");
}
