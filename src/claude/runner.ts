import { exec } from "../utils/exec.js";
import {
	parseChunkResponse,
	parseClaudeResponse,
	parseReconcileChunkResponse,
	validateResponse,
} from "./parser.js";

export interface ClaudeResult {
	spec: string;
	changelog: string;
	commitMessage: string;
	sessionId: string;
	costUsd: number;
}

export interface ClaudeChunkResult {
	specPatch: string;
	sectionsChanged: string[];
	sessionId: string;
	costUsd: number;
}

export interface InvokeClaudeOpts {
	systemPrompt: string;
	userPrompt: string;
	model: string;
	workingDirectory: string;
	alliumSkillsPath: string;
	maxRetries?: number;
}

const EVOLVE_JSON_SCHEMA = JSON.stringify({
	type: "object",
	properties: {
		spec: { type: "string", description: "The updated Allium specification" },
		changelog: { type: "string", description: "Changelog entry for this evolution step" },
		commitMessage: { type: "string", description: "Commit message describing domain model changes" },
	},
	required: ["spec", "changelog", "commitMessage"],
});

const CHUNK_JSON_SCHEMA = JSON.stringify({
	type: "object",
	properties: {
		specPatch: { type: "string", description: "Spec patch describing changes to specific sections" },
		sectionsChanged: {
			type: "array",
			items: { type: "string" },
			description: "List of section names that were changed",
		},
	},
	required: ["specPatch", "sectionsChanged"],
});

function buildClaudeCommand(opts: InvokeClaudeOpts, jsonSchema: string): string {
	const args = [
		"claude",
		"-p",
		`--model ${opts.model}`,
		"--output-format json",
		`--json-schema '${jsonSchema}'`,
		"--dangerously-skip-permissions",
		`--add-dir "${opts.workingDirectory}"`,
		`--add-dir "${opts.alliumSkillsPath}"`,
	];
	return args.join(" ");
}

export async function invokeClaudeForStep(opts: InvokeClaudeOpts): Promise<ClaudeResult> {
	const maxRetries = opts.maxRetries ?? 2;
	let lastError: Error | null = null;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const command = buildClaudeCommand(opts, EVOLVE_JSON_SCHEMA);
			const fullPrompt = `${opts.systemPrompt}\n\n${opts.userPrompt}`;
			const escapedPrompt = fullPrompt.replace(/'/g, "'\\''");

			const { stdout } = await exec(`echo '${escapedPrompt}' | ${command}`, { cwd: opts.workingDirectory });

			const parsed = parseClaudeResponse(stdout);
			const validation = validateResponse(parsed);

			if (!validation.valid) {
				throw new Error(`Validation failed: ${validation.errors.join(", ")}`);
			}

			return {
				spec: parsed.spec,
				changelog: parsed.changelog,
				commitMessage: parsed.commitMessage,
				sessionId: parsed.sessionId,
				costUsd: parsed.costUsd,
			};
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			if (attempt < maxRetries) {
				console.error(`Claude invocation attempt ${attempt + 1} failed, retrying: ${lastError.message}`);
			}
		}
	}

	throw new Error(`Claude invocation failed after ${maxRetries + 1} attempts: ${lastError?.message}`);
}

export async function invokeClaudeForChunk(opts: InvokeClaudeOpts): Promise<ClaudeChunkResult> {
	const command = buildClaudeCommand(opts, CHUNK_JSON_SCHEMA);
	const fullPrompt = `${opts.systemPrompt}\n\n${opts.userPrompt}`;
	const escapedPrompt = fullPrompt.replace(/'/g, "'\\''");

	const { stdout } = await exec(`echo '${escapedPrompt}' | ${command}`, { cwd: opts.workingDirectory });

	const parsed = parseChunkResponse(stdout);

	return {
		specPatch: parsed.specPatch,
		sectionsChanged: parsed.sectionsChanged,
		sessionId: "",
		costUsd: 0,
	};
}

export interface ReconciliationFinding {
	type: "addition" | "removal" | "modification";
	specSection: string;
	description: string;
	sourcePaths: string[];
}

export interface ReconcileChunkResult {
	findings: ReconciliationFinding[];
	sectionsAffected: string[];
	costUsd: number;
}

const RECONCILE_CHUNK_SCHEMA = JSON.stringify({
	type: "object",
	properties: {
		findings: {
			type: "array",
			items: {
				type: "object",
				properties: {
					type: { type: "string", enum: ["addition", "removal", "modification"] },
					specSection: { type: "string" },
					description: { type: "string" },
					sourcePaths: { type: "array", items: { type: "string" } },
				},
				required: ["type", "specSection", "description", "sourcePaths"],
			},
		},
		sectionsAffected: { type: "array", items: { type: "string" } },
	},
	required: ["findings", "sectionsAffected"],
});

export async function invokeClaudeForReconcileChunk(opts: InvokeClaudeOpts): Promise<ReconcileChunkResult> {
	const command = buildClaudeCommand(opts, RECONCILE_CHUNK_SCHEMA);
	const fullPrompt = `${opts.systemPrompt}\n\n${opts.userPrompt}`;
	const escapedPrompt = fullPrompt.replace(/'/g, "'\\''");

	const { stdout } = await exec(`echo '${escapedPrompt}' | ${command}`, { cwd: opts.workingDirectory });

	const parsed = parseReconcileChunkResponse(stdout);

	return {
		findings: parsed.findings,
		sectionsAffected: parsed.sectionsAffected,
		costUsd: parsed.costUsd,
	};
}

export async function invokeClaudeForReconcileCombine(opts: InvokeClaudeOpts): Promise<ClaudeResult> {
	return invokeClaudeForStep(opts);
}
