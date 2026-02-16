import { describe, expect, it } from "vitest";
import { splitOversizedChunks, type SourceChunk, type SourceFile } from "../../src/reconciliation/source-reader.js";

function makeFile(path: string, tokens: number): SourceFile {
	return { path, content: `content of ${path}`, tokens };
}

function makeChunk(groupKey: string, files: SourceFile[]): SourceChunk {
	return {
		groupKey,
		files,
		totalTokens: files.reduce((sum, f) => sum + f.tokens, 0),
	};
}

describe("source-reader", () => {
	describe("splitOversizedChunks", () => {
		it("should not split chunks under the token limit", () => {
			const chunks: SourceChunk[] = [
				makeChunk("src", [makeFile("src/a.ts", 100), makeFile("src/b.ts", 200)]),
			];
			const result = splitOversizedChunks(chunks, 1000);
			expect(result).toHaveLength(1);
			expect(result[0]!.groupKey).toBe("src");
		});

		it("should split oversized chunks into subdirectories", () => {
			const chunks: SourceChunk[] = [
				makeChunk("src", [
					makeFile("src/entities/user.ts", 500),
					makeFile("src/entities/team.ts", 500),
					makeFile("src/routes/auth.ts", 500),
					makeFile("src/routes/payments.ts", 500),
				]),
			];
			const result = splitOversizedChunks(chunks, 1200);
			expect(result.length).toBeGreaterThanOrEqual(2);
			const keys = result.map((c) => c.groupKey).sort();
			expect(keys).toContain("src/entities");
			expect(keys).toContain("src/routes");
		});

		it("should recursively split deeply nested oversized chunks", () => {
			const chunks: SourceChunk[] = [
				makeChunk("packages/app", [
					makeFile("packages/app/entities/user.ts", 500),
					makeFile("packages/app/entities/team.ts", 500),
					makeFile("packages/app/routes/auth.ts", 500),
				]),
			];
			const result = splitOversizedChunks(chunks, 600);
			expect(result.length).toBeGreaterThanOrEqual(2);
		});

		it("should keep chunks that cannot be subdivided further", () => {
			const chunks: SourceChunk[] = [
				makeChunk("src", [makeFile("src/big-file.ts", 5000)]),
			];
			const result = splitOversizedChunks(chunks, 1000);
			expect(result).toHaveLength(1);
			expect(result[0]!.totalTokens).toBe(5000);
		});

		it("should handle mixed sized chunks", () => {
			const chunks: SourceChunk[] = [
				makeChunk("small", [makeFile("small/a.ts", 100)]),
				makeChunk("large", [
					makeFile("large/sub1/a.ts", 800),
					makeFile("large/sub2/b.ts", 800),
				]),
			];
			const result = splitOversizedChunks(chunks, 1000);
			expect(result.length).toBe(3);
			expect(result[0]!.groupKey).toBe("small");
		});

		it("should handle empty chunks array", () => {
			const result = splitOversizedChunks([], 1000);
			expect(result).toEqual([]);
		});
	});
});
