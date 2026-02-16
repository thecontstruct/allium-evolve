import type { ReconciliationConfig } from "../config.js";
import { exec } from "../utils/exec.js";
import { estimateTokens } from "../utils/tokens.js";

export interface SourceFile {
	path: string;
	content: string;
	tokens: number;
}

export interface SourceChunk {
	groupKey: string;
	files: SourceFile[];
	totalTokens: number;
}

export interface SourceReadResult {
	chunks: SourceChunk[];
	skippedFiles: string[];
}

const MONOREPO_CONTAINERS = new Set(["packages", "apps", "libs", "tooling", "config", "services", "modules"]);

const BINARY_EXTENSIONS = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg",
	".woff", ".woff2", ".ttf", ".eot",
	".zip", ".tar", ".gz", ".br",
	".pdf", ".doc", ".docx",
	".mp3", ".mp4", ".wav", ".webm",
	".wasm", ".so", ".dylib", ".dll",
]);

function simpleGlobMatch(pattern: string, basename: string): boolean {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const regexStr = `^${escaped.replace(/\*/g, "[^/]*")}$`;
	return new RegExp(regexStr).test(basename);
}

function isBinaryPath(filePath: string): boolean {
	const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
	return BINARY_EXTENSIONS.has(ext);
}

function shouldIgnore(filePath: string, patterns: string[]): boolean {
	const basename = filePath.split("/").pop() ?? filePath;
	return patterns.some((p) => simpleGlobMatch(p, basename));
}

function getGroupKey(filePath: string): string {
	const segments = filePath.split("/");
	if (segments.length <= 1) {
		return ".";
	}
	const first = segments[0]!;
	if (MONOREPO_CONTAINERS.has(first) && segments.length >= 3) {
		return `${segments[0]}/${segments[1]}`;
	}
	return first;
}

function groupFiles(files: SourceFile[]): SourceChunk[] {
	const groups = new Map<string, SourceFile[]>();
	for (const file of files) {
		const key = getGroupKey(file.path);
		const existing = groups.get(key);
		if (existing) {
			existing.push(file);
		} else {
			groups.set(key, [file]);
		}
	}

	return [...groups.entries()].map(([groupKey, groupFiles]) => ({
		groupKey,
		files: groupFiles,
		totalTokens: groupFiles.reduce((sum, f) => sum + f.tokens, 0),
	}));
}

export function splitOversizedChunks(chunks: SourceChunk[], maxTokens: number): SourceChunk[] {
	const result: SourceChunk[] = [];

	for (const chunk of chunks) {
		if (chunk.totalTokens <= maxTokens) {
			result.push(chunk);
			continue;
		}

		const subGroups = new Map<string, SourceFile[]>();
		for (const file of chunk.files) {
			const relativePath = file.path.startsWith(`${chunk.groupKey}/`)
				? file.path.slice(chunk.groupKey.length + 1)
				: file.path;
			const nextSegment = relativePath.split("/")[0] ?? ".";
			const subKey = chunk.groupKey === "." ? nextSegment : `${chunk.groupKey}/${nextSegment}`;

			const existing = subGroups.get(subKey);
			if (existing) {
				existing.push(file);
			} else {
				subGroups.set(subKey, [file]);
			}
		}

		if (subGroups.size <= 1) {
			result.push(chunk);
			continue;
		}

		for (const [subKey, subFiles] of subGroups) {
			const subChunk: SourceChunk = {
				groupKey: subKey,
				files: subFiles,
				totalTokens: subFiles.reduce((sum, f) => sum + f.tokens, 0),
			};
			if (subChunk.totalTokens > maxTokens) {
				result.push(...splitOversizedChunks([subChunk], maxTokens));
			} else {
				result.push(subChunk);
			}
		}
	}

	return result;
}

function splitLargeFile(path: string, content: string, maxFileTokens: number): SourceFile[] {
	const lines = content.split("\n");
	const chunks: SourceFile[] = [];
	let start = 0;

	while (start < lines.length) {
		let end = start;
		let chunk = "";

		while (end < lines.length) {
			const candidate = `${chunk}${lines[end]}\n`;
			if (estimateTokens(candidate) > maxFileTokens && end > start) {
				break;
			}
			chunk = candidate;
			end++;
		}

		chunks.push({
			path: `${path}:${start + 1}-${end}`,
			content: chunk,
			tokens: estimateTokens(chunk),
		});
		start = end;
	}

	return chunks;
}

async function listFiles(repoPath: string, sha: string): Promise<string[]> {
	const { stdout } = await exec(`git ls-tree -r --name-only ${sha}`, { cwd: repoPath });
	return stdout.trim().split("\n").filter(Boolean);
}

async function readFileContent(repoPath: string, sha: string, filePath: string): Promise<string> {
	const { stdout } = await exec(`git show ${sha}:${filePath}`, { cwd: repoPath });
	return stdout;
}

export async function readTree(
	repoPath: string,
	sha: string,
	reconciliationConfig: ReconciliationConfig,
	maxDiffTokens: number,
): Promise<SourceReadResult> {
	const allFiles = await listFiles(repoPath, sha);
	const skippedFiles: string[] = [];
	const sourceFiles: SourceFile[] = [];

	const filtered = allFiles.filter((f) => {
		if (isBinaryPath(f)) {
			return false;
		}
		if (shouldIgnore(f, reconciliationConfig.sourceIgnorePatterns)) {
			return false;
		}
		return true;
	});

	let totalTokens = 0;
	for (const filePath of filtered) {
		let content: string;
		try {
			content = await readFileContent(repoPath, sha, filePath);
		} catch {
			skippedFiles.push(filePath);
			continue;
		}

		const tokens = estimateTokens(content);

		if (reconciliationConfig.maxSourceTokens && totalTokens + tokens > reconciliationConfig.maxSourceTokens) {
			skippedFiles.push(filePath);
			continue;
		}

		if (reconciliationConfig.maxFileTokens && tokens > reconciliationConfig.maxFileTokens) {
			const parts = splitLargeFile(filePath, content, reconciliationConfig.maxFileTokens);
			for (const part of parts) {
				totalTokens += part.tokens;
				sourceFiles.push(part);
			}
		} else {
			totalTokens += tokens;
			sourceFiles.push({ path: filePath, content, tokens });
		}
	}

	const grouped = groupFiles(sourceFiles);
	const chunks = splitOversizedChunks(grouped, maxDiffTokens);

	return { chunks, skippedFiles };
}

export async function readDiff(
	repoPath: string,
	fromSha: string,
	toSha: string,
	reconciliationConfig: ReconciliationConfig,
	maxDiffTokens: number,
): Promise<SourceReadResult | null> {
	const { stdout: stat } = await exec(`git diff --stat ${fromSha}...${toSha}`, { cwd: repoPath });
	const statTokens = estimateTokens(stat);

	if (reconciliationConfig.maxSourceTokens && statTokens * 10 > reconciliationConfig.maxSourceTokens) {
		return null;
	}

	const { stdout: diffOutput } = await exec(`git diff ${fromSha}...${toSha}`, { cwd: repoPath });
	const skippedFiles: string[] = [];

	const fileDiffs = diffOutput.split(/^diff --git /m).filter(Boolean);
	const sourceFiles: SourceFile[] = [];

	for (const part of fileDiffs) {
		const headerMatch = part.match(/^a\/\S+\s+b\/(\S+)/);
		if (!headerMatch) continue;

		const filePath = headerMatch[1]!;
		if (isBinaryPath(filePath) || shouldIgnore(filePath, reconciliationConfig.sourceIgnorePatterns)) {
			continue;
		}

		const diffContent = `diff --git ${part}`;
		const tokens = estimateTokens(diffContent);

		if (reconciliationConfig.maxFileTokens && tokens > reconciliationConfig.maxFileTokens) {
			const parts = splitLargeFile(filePath, diffContent, reconciliationConfig.maxFileTokens);
			sourceFiles.push(...parts);
		} else {
			sourceFiles.push({ path: filePath, content: diffContent, tokens });
		}
	}

	const grouped = groupFiles(sourceFiles);
	const chunks = splitOversizedChunks(grouped, maxDiffTokens);

	return { chunks, skippedFiles };
}
