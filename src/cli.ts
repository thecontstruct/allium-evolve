#!/usr/bin/env node --import tsx
import { Command } from "commander";
import { defaultConfig, type EvolutionConfig } from "./config.js";
import { runEvolution } from "./evolution/orchestrator.js";

const program = new Command();

program
	.name("allium-evolve")
	.description("Distill an evolving Allium specification from a git repository's commit history")
	.requiredOption("--repo <path>", "Path to the git repository")
	.option("--ref <ref>", "Target git ref", "HEAD")
	.option("--window-size <n>", "Sliding window size", "5")
	.option("--process-depth <n>", "Number of tail commits to get full diffs", "1")
	.option("--model <model>", "Default Claude model", "sonnet")
	.option("--opus-model <model>", "Opus Claude model for complex steps", "opus")
	.option("--max-diff-tokens <n>", "Maximum diff tokens before chunking", "80000")
	.option("--state-file <path>", "State file path", ".allium-state.json")
	.option("--allium-branch <name>", "Allium branch name", "allium/evolution")
	.option("--max-concurrency <n>", "Max parallel segment runners", "4")
	.option("--max-parse-retries <n>", "Max retries for parser validation failures", "2")
	.option("--parallel-branches", "Enable parallel branch processing (default)", true)
	.option("--no-parallel-branches", "Disable parallel branch processing")
	.option("--allium-skills-path <path>", "Path to Allium skills directory")
	.option("--reconciliation-strategy <strategy>", "Reconciliation strategy (none, n-commits, n-trunk-commits, token-count)", "n-trunk-commits")
	.option("--reconciliation-interval <n>", "Reconciliation interval (commits or token threshold)", "50")
	.action(async (opts) => {
		const config: EvolutionConfig = defaultConfig({
			repoPath: opts.repo,
			targetRef: opts.ref,
			windowSize: Number.parseInt(opts.windowSize, 10),
			processDepth: Number.parseInt(opts.processDepth, 10),
			defaultModel: opts.model,
			opusModel: opts.opusModel,
			maxDiffTokens: Number.parseInt(opts.maxDiffTokens, 10),
			parallelBranches: opts.parallelBranches,
			maxConcurrency: Number.parseInt(opts.maxConcurrency, 10),
			maxParseRetries: Number.parseInt(opts.maxParseRetries, 10),
			stateFile: opts.stateFile,
			alliumBranch: opts.alliumBranch,
			alliumSkillsPath: opts.alliumSkillsPath,
			reconciliation: {
				strategy: opts.reconciliationStrategy,
				interval: Number.parseInt(opts.reconciliationInterval, 10),
			},
		});

		try {
			await runEvolution(config);
			process.exit(0);
			return;
		} catch (err) {
			console.error("Evolution failed:", err);
			process.exit(1);
			return;
		}
	});

program.parse();
