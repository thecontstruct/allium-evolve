import type { EvolutionConfig } from "../config.js";

export type StepType = "initial-commit" | "evolve" | "merge" | "chunk-recombine";

export function getModelForStep(stepType: StepType, config: EvolutionConfig): string {
	switch (stepType) {
		case "initial-commit":
			return config.opusModel;
		case "evolve":
			return config.defaultModel;
		case "merge":
			return config.opusModel;
		case "chunk-recombine":
			return config.defaultModel;
	}
}
