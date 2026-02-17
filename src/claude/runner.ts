import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exec } from "../utils/exec.js";
import { parseClaudeResponse, validateResponse } from "./parser.js";

export interface ClaudeResult {
	spec: string;
	changelog: string;
	commitMessage: string;
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
	maxTurns?: number;
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

function buildClaudeCommand(opts: InvokeClaudeOpts, jsonSchema: string): string {
	const maxTurns = opts.maxTurns ?? 75;
	const args = [
		"claude",
		"-p",
		`--model ${opts.model}`,
		"--output-format json",
		`--max-turns ${maxTurns}`,
		`--json-schema '${jsonSchema}'`,
		"--dangerously-skip-permissions",
		`--add-dir "${opts.workingDirectory}"`,
		`--add-dir "${opts.alliumSkillsPath}"`,
	];
	return args.join(" ");
}

async function invokeClaudeWithTempFile(
	command: string,
	prompt: string,
	cwd: string,
): Promise<string> {
	const tmpFile = join(tmpdir(), `allium-prompt-${randomBytes(8).toString("hex")}.txt`);
	await writeFile(tmpFile, prompt, "utf-8");
	try {
		const { stdout } = await exec(`${command} < "${tmpFile}"`, { cwd });
		return stdout;
	} finally {
		await unlink(tmpFile).catch(() => {});
	}
}

export interface ContextFilesResult {
	dir: string;
	manifest: string[];
	cleanup: () => Promise<void>;
}

export async function writeContextFiles(
	workingDir: string,
	files: Record<string, string>,
): Promise<ContextFilesResult> {
	const id = randomBytes(8).toString("hex");
	const dir = join(workingDir, ".allium-tmp", id);
	await mkdir(dir, { recursive: true });

	const manifest: string[] = [];
	for (const [name, content] of Object.entries(files)) {
		const filePath = join(dir, name);
		const fileDir = join(dir, ...name.split("/").slice(0, -1));
		if (fileDir !== dir) {
			await mkdir(fileDir, { recursive: true });
		}
		await writeFile(filePath, content, "utf-8");
		manifest.push(`.allium-tmp/${id}/${name}`);
	}

	const cleanup = async () => {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	};

	return { dir, manifest, cleanup };
}

export async function cleanupStaleContextFiles(workingDir: string): Promise<void> {
	const tmpDir = join(workingDir, ".allium-tmp");
	try {
		const entries = await readdir(tmpDir);
		const oneHourAgo = Date.now() - 60 * 60 * 1000;
		for (const entry of entries) {
			const entryPath = join(tmpDir, entry);
			const stats = await stat(entryPath).catch(() => null);
			if (stats && stats.mtimeMs < oneHourAgo) {
				await rm(entryPath, { recursive: true, force: true }).catch(() => {});
			}
		}
	} catch {
		// Directory doesn't exist, nothing to clean
	}
}

export function formatManifest(manifest: string[]): string {
	return manifest.map((f) => `- \`${f}\``).join("\n");
}

export async function invokeClaudeForStep(opts: InvokeClaudeOpts): Promise<ClaudeResult> {
	const maxRetries = opts.maxRetries ?? 2;
	let lastError: Error | null = null;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const command = buildClaudeCommand(opts, EVOLVE_JSON_SCHEMA);
			const fullPrompt = `${opts.systemPrompt}\n\n${opts.userPrompt}`;

			const stdout = await invokeClaudeWithTempFile(command, fullPrompt, opts.workingDirectory);

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
