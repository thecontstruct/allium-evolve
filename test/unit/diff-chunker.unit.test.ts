import type { DiffChunk, DiffFile } from "../../src/evolution/diff-chunker.js";
import {
	chunkDiff,
	filterIgnoredFiles,
	groupByDirectory,
	parseDiffIntoFiles,
	splitOversizedChunks,
} from "../../src/evolution/diff-chunker.js";
import { estimateTokens } from "../../src/utils/tokens.js";

// ---------------------------------------------------------------------------
// Shared test diff fixtures
// ---------------------------------------------------------------------------

const MULTI_FILE_DIFF = `diff --git a/packages/api/src/routes.ts b/packages/api/src/routes.ts
index abc1234..def5678 100644
--- a/packages/api/src/routes.ts
+++ b/packages/api/src/routes.ts
@@ -1,3 +1,5 @@
+import { auth } from './auth';
 export function getRoutes() {
   return [];
+  // added route
 }
diff --git a/packages/auth/src/index.ts b/packages/auth/src/index.ts
index abc1234..def5678 100644
--- a/packages/auth/src/index.ts
+++ b/packages/auth/src/index.ts
@@ -1,1 +1,2 @@
 export const auth = {};
+export const session = {};
diff --git a/package-lock.json b/package-lock.json
index abc1234..def5678 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,1 +1,100 @@
+lots of lock content
`;

const ROOT_FILE_DIFF = `diff --git a/README.md b/README.md
index abc1234..def5678 100644
--- a/README.md
+++ b/README.md
@@ -1,1 +1,2 @@
 # Project
+Added description
diff --git a/.gitignore b/.gitignore
index abc1234..def5678 100644
--- a/.gitignore
+++ b/.gitignore
@@ -1,1 +1,2 @@
 node_modules
+dist
`;

// ---------------------------------------------------------------------------
// Helper to build a DiffFile without parsing
// ---------------------------------------------------------------------------

function makeDiffFile(path: string, bodyLength = 100): DiffFile {
	const diff = "x".repeat(bodyLength);
	return { path, diff, tokens: estimateTokens(diff) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("diff-chunker", () => {
	// -----------------------------------------------------------------------
	// parseDiffIntoFiles
	// -----------------------------------------------------------------------

	describe("UNIT-053: parseDiffIntoFiles splits multi-file diff into individual entries", () => {
		it("returns one entry per file in the diff", () => {
			const files = parseDiffIntoFiles(MULTI_FILE_DIFF);
			expect(files).toHaveLength(3);
		});

		it("each entry has non-empty diff and positive tokens", () => {
			const files = parseDiffIntoFiles(MULTI_FILE_DIFF);
			for (const f of files) {
				expect(f.diff.length).toBeGreaterThan(0);
				expect(f.tokens).toBeGreaterThan(0);
			}
		});
	});

	describe("UNIT-054: parseDiffIntoFiles extracts correct file paths", () => {
		it("extracts the b/ side file path for each entry", () => {
			const files = parseDiffIntoFiles(MULTI_FILE_DIFF);
			const paths = files.map((f) => f.path);
			expect(paths).toEqual(["packages/api/src/routes.ts", "packages/auth/src/index.ts", "package-lock.json"]);
		});
	});

	// -----------------------------------------------------------------------
	// filterIgnoredFiles
	// -----------------------------------------------------------------------

	describe("UNIT-055: filterIgnoredFiles removes lock files (*-lock.*)", () => {
		it("filters out package-lock.json", () => {
			const files = parseDiffIntoFiles(MULTI_FILE_DIFF);
			const filtered = filterIgnoredFiles(files, ["*-lock.*"]);
			const paths = filtered.map((f) => f.path);
			expect(paths).not.toContain("package-lock.json");
		});

		it("also filters pnpm-lock.yaml style names", () => {
			const fake: DiffFile[] = [makeDiffFile("pnpm-lock.yaml"), makeDiffFile("src/index.ts")];
			const filtered = filterIgnoredFiles(fake, ["*-lock.*"]);
			expect(filtered).toHaveLength(1);
			expect(filtered[0]!.path).toBe("src/index.ts");
		});
	});

	describe("UNIT-056: filterIgnoredFiles removes minified files (*.min.*)", () => {
		it("filters out .min.js and .min.css files", () => {
			const fake: DiffFile[] = [
				makeDiffFile("dist/bundle.min.js"),
				makeDiffFile("dist/styles.min.css"),
				makeDiffFile("src/app.ts"),
			];
			const filtered = filterIgnoredFiles(fake, ["*.min.*"]);
			expect(filtered).toHaveLength(1);
			expect(filtered[0]!.path).toBe("src/app.ts");
		});
	});

	describe("UNIT-057: filterIgnoredFiles preserves non-matching files", () => {
		it("keeps all files when no patterns match", () => {
			const files = parseDiffIntoFiles(MULTI_FILE_DIFF);
			const filtered = filterIgnoredFiles(files, ["*.generated.*"]);
			expect(filtered).toHaveLength(files.length);
		});

		it("keeps non-matching files when some are filtered", () => {
			const files = parseDiffIntoFiles(MULTI_FILE_DIFF);
			const filtered = filterIgnoredFiles(files, ["*-lock.*"]);
			expect(filtered).toHaveLength(2);
			expect(filtered.map((f) => f.path)).toEqual(["packages/api/src/routes.ts", "packages/auth/src/index.ts"]);
		});
	});

	// -----------------------------------------------------------------------
	// groupByDirectory
	// -----------------------------------------------------------------------

	describe("UNIT-058: groupByDirectory groups by top-level directory", () => {
		it("groups monorepo packages by first 2 segments", () => {
			const files: DiffFile[] = [
				makeDiffFile("packages/api/src/routes.ts"),
				makeDiffFile("packages/api/src/auth.ts"),
				makeDiffFile("packages/auth/src/index.ts"),
			];
			const chunks = groupByDirectory(files);
			const keys = chunks.map((c) => c.groupKey).sort();
			expect(keys).toEqual(["packages/api", "packages/auth"]);
		});

		it("groups non-monorepo paths by first segment", () => {
			const files: DiffFile[] = [
				makeDiffFile("src/index.ts"),
				makeDiffFile("src/utils/helpers.ts"),
				makeDiffFile("lib/core.ts"),
			];
			const chunks = groupByDirectory(files);
			const keys = chunks.map((c) => c.groupKey).sort();
			expect(keys).toEqual(["lib", "src"]);
		});

		it("computes correct totalTokens per chunk", () => {
			const files: DiffFile[] = [makeDiffFile("packages/api/src/a.ts", 40), makeDiffFile("packages/api/src/b.ts", 80)];
			const chunks = groupByDirectory(files);
			expect(chunks).toHaveLength(1);
			expect(chunks[0]!.totalTokens).toBe(files[0]!.tokens + files[1]!.tokens);
		});
	});

	describe("UNIT-059: groupByDirectory puts root files in '.' group", () => {
		it("assigns '.' as groupKey for root-level files", () => {
			const files = parseDiffIntoFiles(ROOT_FILE_DIFF);
			const chunks = groupByDirectory(files);
			expect(chunks).toHaveLength(1);
			expect(chunks[0]!.groupKey).toBe(".");
			expect(chunks[0]!.files).toHaveLength(2);
		});
	});

	// -----------------------------------------------------------------------
	// splitOversizedChunks
	// -----------------------------------------------------------------------

	describe("UNIT-060: splitOversizedChunks subdivides when chunk exceeds maxTokens", () => {
		it("splits a large chunk into sub-directory chunks", () => {
			const files: DiffFile[] = [
				makeDiffFile("packages/api/src/routes.ts", 400),
				makeDiffFile("packages/api/test/routes.test.ts", 400),
			];
			const chunk: DiffChunk = {
				groupKey: "packages/api",
				files,
				totalTokens: files.reduce((s, f) => s + f.tokens, 0),
			};

			// Set maxTokens lower than totalTokens but high enough for each sub-chunk
			const maxTokens = chunk.totalTokens - 1;
			const result = splitOversizedChunks([chunk], maxTokens);

			expect(result.length).toBeGreaterThan(1);
			const keys = result.map((c) => c.groupKey).sort();
			expect(keys).toContain("packages/api/src");
			expect(keys).toContain("packages/api/test");
		});

		it("leaves chunks that are under maxTokens unchanged", () => {
			const files: DiffFile[] = [makeDiffFile("src/index.ts", 40)];
			const chunk: DiffChunk = {
				groupKey: "src",
				files,
				totalTokens: files[0]!.tokens,
			};
			const result = splitOversizedChunks([chunk], 99999);
			expect(result).toHaveLength(1);
			expect(result[0]!.groupKey).toBe("src");
		});
	});

	// -----------------------------------------------------------------------
	// chunkDiff (integration of all helpers)
	// -----------------------------------------------------------------------

	describe("UNIT-061: chunkDiff returns needsChunking=false when under threshold", () => {
		it("returns needsChunking=false and empty chunks", () => {
			const result = chunkDiff({
				fullDiff: MULTI_FILE_DIFF,
				maxDiffTokens: 999999,
				ignorePatterns: ["*-lock.*"],
			});
			expect(result.needsChunking).toBe(false);
			expect(result.chunks).toEqual([]);
		});
	});

	describe("UNIT-062: chunkDiff returns needsChunking=true with chunks when over threshold", () => {
		it("returns needsChunking=true and non-empty chunks", () => {
			const result = chunkDiff({
				fullDiff: MULTI_FILE_DIFF,
				maxDiffTokens: 1, // impossibly low to force chunking
				ignorePatterns: ["*-lock.*"],
			});
			expect(result.needsChunking).toBe(true);
			expect(result.chunks.length).toBeGreaterThan(0);
		});

		it("respects ignore patterns before chunking", () => {
			const result = chunkDiff({
				fullDiff: MULTI_FILE_DIFF,
				maxDiffTokens: 1,
				ignorePatterns: ["*-lock.*"],
			});
			const allPaths = result.chunks.flatMap((c) => c.files.map((f) => f.path));
			expect(allPaths).not.toContain("package-lock.json");
		});

		it("every chunk contains files with valid tokens", () => {
			const result = chunkDiff({
				fullDiff: MULTI_FILE_DIFF,
				maxDiffTokens: 1,
				ignorePatterns: [],
			});
			for (const chunk of result.chunks) {
				expect(chunk.files.length).toBeGreaterThan(0);
				expect(chunk.totalTokens).toBeGreaterThan(0);
			}
		});
	});
});
