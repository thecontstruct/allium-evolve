import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type ReconciliationStrategy = "none" | "n-commits" | "n-trunk-commits" | "token-count";

export interface ReconciliationConfig {
	strategy: ReconciliationStrategy;
	interval: number;
	model?: string;
	sourceIgnorePatterns: string[];
	maxConcurrency: number;
	maxSourceTokens?: number;
	maxFileTokens?: number;
}

export interface EvolutionConfig {
	repoPath: string;
	targetRef: string;
	startAfter?: string;
	seedSpecFrom?: string;
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
	reconciliation: ReconciliationConfig;
}

const DEFAULT_SOURCE_IGNORE_PATTERNS = [
	"*.test.*",
	"*.spec.*",
	"*.config.*",
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"*.min.js",
	"*.min.css",
	"*.bundle.js",
	"*.map",
];

function defaultReconciliationConfig(
	overrides?: Partial<ReconciliationConfig>,
): ReconciliationConfig {
	return {
		strategy: overrides?.strategy ?? "n-trunk-commits",
		interval: overrides?.interval ?? 50,
		model: overrides?.model,
		sourceIgnorePatterns: overrides?.sourceIgnorePatterns ?? DEFAULT_SOURCE_IGNORE_PATTERNS,
		maxConcurrency: overrides?.maxConcurrency ?? 5,
		maxSourceTokens: overrides?.maxSourceTokens,
		maxFileTokens: overrides?.maxFileTokens,
	};
}

export function defaultConfig(overrides: Partial<EvolutionConfig> = {}): EvolutionConfig {
	return {
		repoPath: resolve(overrides.repoPath ?? process.cwd()),
		targetRef: overrides.targetRef ?? "HEAD",
		startAfter: overrides.startAfter,
		seedSpecFrom: overrides.seedSpecFrom,
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
		reconciliation: defaultReconciliationConfig(overrides.reconciliation),
	};
}
