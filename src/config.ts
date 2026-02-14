import { homedir } from "node:os";
import { join } from "node:path";

export interface EvolutionConfig {
	repoPath: string;
	targetRef: string;
	windowSize: number;
	processDepth: number;
	defaultModel: string;
	opusModel: string;
	maxDiffTokens: number;
	parallelBranches: boolean;
	maxConcurrency: number;
	stateFile: string;
	alliumBranch: string;
	maxParseRetries: number;
	diffIgnorePatterns: string[];
	alliumSkillsPath: string;
}

export function defaultConfig(overrides: Partial<EvolutionConfig> = {}): EvolutionConfig {
	return {
		repoPath: overrides.repoPath ?? process.cwd(),
		targetRef: overrides.targetRef ?? "HEAD",
		windowSize: overrides.windowSize ?? 5,
		processDepth: overrides.processDepth ?? 1,
		defaultModel: overrides.defaultModel ?? "sonnet",
		opusModel: overrides.opusModel ?? "opus",
		maxDiffTokens: overrides.maxDiffTokens ?? 80000,
		parallelBranches: overrides.parallelBranches ?? true,
		maxConcurrency: overrides.maxConcurrency ?? 4,
		stateFile: overrides.stateFile ?? ".allium-state.json",
		alliumBranch: overrides.alliumBranch ?? "allium/evolution",
		maxParseRetries: overrides.maxParseRetries ?? 2,
		diffIgnorePatterns: overrides.diffIgnorePatterns ?? ["*-lock.*", "*.min.*", "*.generated.*"],
		alliumSkillsPath: overrides.alliumSkillsPath ?? join(homedir(), ".claude", "skills", "allium"),
	};
}
