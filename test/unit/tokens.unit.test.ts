import { estimateTokens } from "../../src/utils/tokens.js";

describe("estimateTokens", () => {
	describe("UNIT-011: Token estimation returns reasonable counts for known strings", () => {
		it("returns a positive count for a simple sentence", () => {
			const text = "Hello, world! This is a test sentence.";
			const tokens = estimateTokens(text);
			expect(tokens).toBeGreaterThan(0);
			// A ~38-char sentence should be roughly 5-15 tokens
			expect(tokens).toBeGreaterThanOrEqual(5);
			expect(tokens).toBeLessThanOrEqual(20);
		});

		it("returns a count within a reasonable range for a paragraph", () => {
			const text =
				"The quick brown fox jumps over the lazy dog. " +
				"Pack my box with five dozen liquor jugs. " +
				"How vexingly quick daft zebras jump.";
			const tokens = estimateTokens(text);
			// ~128 chars => roughly 25-45 tokens
			expect(tokens).toBeGreaterThan(15);
			expect(tokens).toBeLessThan(60);
		});
	});

	describe("UNIT-012: Empty string returns 0", () => {
		it("returns 0 for an empty string", () => {
			expect(estimateTokens("")).toBe(0);
		});
	});

	describe("UNIT-013: Large text estimation is proportional to length", () => {
		it("doubles approximately when text doubles", () => {
			const base = "word ".repeat(100);
			const doubled = base + base;

			const baseTokens = estimateTokens(base);
			const doubledTokens = estimateTokens(doubled);

			// Doubled text should have roughly doubled tokens (within 30% tolerance)
			const ratio = doubledTokens / baseTokens;
			expect(ratio).toBeGreaterThan(1.5);
			expect(ratio).toBeLessThan(2.5);
		});

		it("handles large text without throwing", () => {
			const largeText = "The quick brown fox jumps over the lazy dog. ".repeat(200);
			const tokens = estimateTokens(largeText);
			expect(tokens).toBeGreaterThan(0);
		});
	});
});
