import { describe, expect, it } from "vitest";
import { formatOriginalLine, parseOriginalSha } from "../../src/git/commit-metadata.js";

describe("commit-metadata", () => {
	describe("parseOriginalSha", () => {
		it("extracts 40-char SHA from commit body", () => {
			const body = "allium: add User entity\n\nOriginal: abcdef1234567890abcdef1234567890abcdef12 \"feat: init\"\nWindow: abc..def";
			expect(parseOriginalSha(body)).toBe("abcdef1234567890abcdef1234567890abcdef12");
		});

		it("returns null when no match", () => {
			expect(parseOriginalSha("no Original line here")).toBeNull();
			expect(parseOriginalSha("Original: short")).toBeNull();
		});

		it("matches first line with Original: prefix", () => {
			const sha1 = "1".repeat(40);
			const sha2 = "2".repeat(40);
			const body = `allium: merge\n\nOriginal: ${sha1} "m1"\nOriginal: ${sha2} "m2"`;
			expect(parseOriginalSha(body)).toBe(sha1);
		});
	});

	describe("formatOriginalLine", () => {
		it("produces correct format", () => {
			expect(formatOriginalLine("abc123", "feat: add user")).toBe('Original: abc123 "feat: add user"');
		});

		it("round-trips with parseOriginalSha", () => {
			const sha = "abcdef1234567890abcdef1234567890abcdef12";
			const msg = "feat: init";
			const line = formatOriginalLine(sha, msg);
			const body = `allium: foo\n\n${line}\n`;
			expect(parseOriginalSha(body)).toBe(sha);
		});
	});
});
