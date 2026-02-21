#!/usr/bin/env node --import tsx
import { Command } from "commander";
import { defaultConfig, type EvolutionConfig } from "./config.js";
import { computeSetupStats, formatSetupStats } from "./evolution/estimator.js";
import { runEvolution, setupEvolution } from "./evolution/orchestrator.js";
import { GracefulShutdownError, ShutdownSignal } from "./shutdown.js";
import { exec } from "./utils/exec.js";

const program = new Command();

program
	.name("allium-evolve")
	.description("Distill an evolving Allium specification from a git repository's commit history")
	.requiredOption("--repo <path>", "Path to the git repository")
	.option("--ref <ref>", "Target git ref", "HEAD")
	.option("--start-after <sha>", "Resume after this original commit (exclusive); requires --seed-spec or existing --allium-branch")
	.option("--seed-spec <allium-sha>", "Allium commit SHA to read initial spec from; omit to auto-resolve from --allium-branch")
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
	.option("--setup-only", "Analyze repository and display cost/time estimates without processing")
	.action(async (opts) => {
		let config: EvolutionConfig = defaultConfig({
			repoPath: opts.repo,
			targetRef: opts.ref,
			startAfter: opts.startAfter,
			seedSpecFrom: opts.seedSpec,
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

		if (config.startAfter) {
			try {
				const { stdout: startAfterSha } = await exec(`git rev-parse ${config.startAfter}`, {
					cwd: config.repoPath,
				});
				config = { ...config, startAfter: startAfterSha.trim() };
			} catch {
				throw new Error(
					`SHA '${config.startAfter}' does not exist in the repository. Verify the --start-after value.`,
				);
			}
			if (config.seedSpecFrom) {
				try {
					const { stdout: seedSha } = await exec(`git rev-parse ${config.seedSpecFrom}`, {
						cwd: config.repoPath,
					});
					config = { ...config, seedSpecFrom: seedSha.trim() };
				} catch {
					throw new Error(
						`SHA '${config.seedSpecFrom}' does not exist in the repository. Verify the --seed-spec value.`,
					);
				}
			} else {
				try {
					await exec(`git rev-parse --verify refs/heads/${config.alliumBranch}`, {
						cwd: config.repoPath,
					});
				} catch {
					throw new Error(
						`--start-after requires --seed-spec or an existing branch '${config.alliumBranch}'. The branch does not exist in the repository.`,
					);
				}
			}
		}

		if (opts.setupOnly) {
			try {
				const setup = await setupEvolution(config);
				const stats = computeSetupStats(
					setup.dag,
					setup.segments,
					setup.stateTracker,
					config,
					setup.isResume,
				);
				console.log(formatSetupStats(stats));
				process.exit(0);
				return;
			} catch (err) {
				console.error("Setup failed:", err);
				process.exit(1);
				return;
			}
		}

		const shutdownSignal = new ShutdownSignal();
		let forceExit = false;
		process.on("SIGINT", () => {
			if (forceExit) {
				console.error("[allium-evolve] Force shutdown.");
				process.exit(1);
			}
			shutdownSignal.request();
			forceExit = true;
		});

		try {
			await runEvolution(config, shutdownSignal);
			process.exit(0);
			return;
		} catch (err) {
			if (err instanceof GracefulShutdownError) {
				console.error("[allium-evolve] Graceful shutdown complete. State saved — safe to resume.");
				process.exit(0);
				return;
			}
			console.error("Evolution failed:", err);
			process.exit(1);
			return;
		}
	});

program.parse();
