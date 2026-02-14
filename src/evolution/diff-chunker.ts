import { estimateTokens } from "../utils/tokens.js";

export interface DiffFile {
	path: string;
	diff: string;
	tokens: number;
}

export interface DiffChunk {
	groupKey: string;
	files: DiffFile[];
	totalTokens: number;
}

/**
 * Simple glob matching against a basename.
 * Supports `*` matching any sequence of non-/ characters.
 * e.g. `*-lock.*`, `*.min.*`, `*.generated.*`
 */
function simpleGlobMatch(pattern: string, basename: string): boolean {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const regexStr = "^" + escaped.replace(/\*/g, "[^/]*") + "$";
	return new RegExp(regexStr).test(basename);
}

/** Parse a combined diff into individual file diffs */
export function parseDiffIntoFiles(fullDiff: string): DiffFile[] {
	const files: DiffFile[] = [];
	const parts = fullDiff.split(/^diff --git /m);

	for (const part of parts) {
		if (!part.trim()) {
			continue;
		}

		const headerMatch = part.match(/^a\/\S+\s+b\/(\S+)/);
		if (!headerMatch) {
			continue;
		}

		const path = headerMatch[1]!;
		const diff = "diff --git " + part;
		const tokens = estimateTokens(diff);

		files.push({ path, diff, tokens });
	}

	return files;
}

/** Filter out files matching ignore patterns (glob-style on basename) */
export function filterIgnoredFiles(files: DiffFile[], patterns: string[]): DiffFile[] {
	return files.filter((file) => {
		const basename = file.path.split("/").pop() ?? file.path;
		return !patterns.some((pattern) => simpleGlobMatch(pattern, basename));
	});
}

/** Known monorepo container directories that use 2-segment grouping */
const MONOREPO_CONTAINERS = new Set(["packages", "apps", "libs", "tooling", "config", "services", "modules"]);

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

/** Group files by top-level directory (first 1-2 path segments) */
export function groupByDirectory(files: DiffFile[]): DiffChunk[] {
	const groups = new Map<string, DiffFile[]>();

	for (const file of files) {
		const key = getGroupKey(file.path);
		const group = groups.get(key);
		if (group) {
			group.push(file);
		} else {
			groups.set(key, [file]);
		}
	}

	const chunks: DiffChunk[] = [];
	for (const [groupKey, groupFiles] of groups) {
		chunks.push({
			groupKey,
			files: groupFiles,
			totalTokens: groupFiles.reduce((sum, f) => sum + f.tokens, 0),
		});
	}

	return chunks;
}

/** Split chunks that exceed maxTokens by subdividing into deeper directories */
export function splitOversizedChunks(chunks: DiffChunk[], maxTokens: number): DiffChunk[] {
	const result: DiffChunk[] = [];

	for (const chunk of chunks) {
		if (chunk.totalTokens <= maxTokens) {
			result.push(chunk);
			continue;
		}

		const subGroups = new Map<string, DiffFile[]>();

		for (const file of chunk.files) {
			const relativePath = file.path.startsWith(chunk.groupKey + "/")
				? file.path.slice(chunk.groupKey.length + 1)
				: file.path;

			const nextSegment = relativePath.split("/")[0] ?? ".";
			const subKey = chunk.groupKey === "." ? nextSegment : `${chunk.groupKey}/${nextSegment}`;

			const group = subGroups.get(subKey);
			if (group) {
				group.push(file);
			} else {
				subGroups.set(subKey, [file]);
			}
		}

		// Cannot subdivide further — keep as-is
		if (subGroups.size <= 1) {
			result.push(chunk);
			continue;
		}

		for (const [subKey, subFiles] of subGroups) {
			const subChunk: DiffChunk = {
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

/** Main entry: determine if chunking is needed and produce chunks */
export function chunkDiff(opts: { fullDiff: string; maxDiffTokens: number; ignorePatterns: string[] }): {
	needsChunking: boolean;
	chunks: DiffChunk[];
} {
	const allFiles = parseDiffIntoFiles(opts.fullDiff);
	const files = filterIgnoredFiles(allFiles, opts.ignorePatterns);

	const totalTokens = files.reduce((sum, f) => sum + f.tokens, 0);

	if (totalTokens <= opts.maxDiffTokens) {
		return { needsChunking: false, chunks: [] };
	}

	const chunks = groupByDirectory(files);
	const splitChunks = splitOversizedChunks(chunks, opts.maxDiffTokens);

	return { needsChunking: true, chunks: splitChunks };
}
