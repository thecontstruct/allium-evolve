import { describe, expect, it } from "vitest";
import { parseClaudeResponse, validateResponse } from "../../src/claude/parser.js";

function makeLegacyEnvelope(resultObj: Record<string, unknown>, overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "result",
		subtype: "success",
		cost_usd: 0.05,
		duration_ms: 5000,
		duration_api_ms: 4500,
		is_error: false,
		num_turns: 1,
		result: JSON.stringify(resultObj),
		session_id: "sess-abc123",
		...overrides,
	});
}

function makeStructuredEnvelope(resultObj: Record<string, unknown>, overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "result",
		subtype: "success",
		total_cost_usd: 0.05,
		duration_ms: 5000,
		duration_api_ms: 4500,
		is_error: false,
		num_turns: 1,
		result: "",
		structured_output: resultObj,
		session_id: "sess-abc123",
		...overrides,
	});
}

describe("claude/parser.ts", () => {
	describe("UNIT-033: Parse valid full response extracts spec, changelog, commitMessage", () => {
		it("should extract from legacy result-string envelope", () => {
			const raw = makeLegacyEnvelope({
				spec: "# My Spec\nSome content",
				changelog: "- Added feature X",
				commitMessage: "feat: add feature X",
			});

			const parsed = parseClaudeResponse(raw);

			expect(parsed.spec).toBe("# My Spec\nSome content");
			expect(parsed.changelog).toBe("- Added feature X");
			expect(parsed.commitMessage).toBe("feat: add feature X");
		});

		it("should extract from structured_output envelope", () => {
			const raw = makeStructuredEnvelope({
				spec: "# My Spec\nSome content",
				changelog: "- Added feature X",
				commitMessage: "feat: add feature X",
			});

			const parsed = parseClaudeResponse(raw);

			expect(parsed.spec).toBe("# My Spec\nSome content");
			expect(parsed.changelog).toBe("- Added feature X");
			expect(parsed.commitMessage).toBe("feat: add feature X");
		});
	});

	describe("UNIT-034: Parse extracts cost and session ID from envelope", () => {
		it("should extract costUsd from legacy cost_usd field", () => {
			const raw = makeLegacyEnvelope(
				{ spec: "spec", changelog: "changelog", commitMessage: "msg" },
				{ cost_usd: 0.123, session_id: "sess-xyz789" },
			);

			const parsed = parseClaudeResponse(raw);

			expect(parsed.costUsd).toBe(0.123);
			expect(parsed.sessionId).toBe("sess-xyz789");
		});

		it("should extract costUsd from total_cost_usd field", () => {
			const raw = makeStructuredEnvelope(
				{ spec: "spec", changelog: "changelog", commitMessage: "msg" },
				{ total_cost_usd: 0.456, session_id: "sess-xyz789" },
			);

			const parsed = parseClaudeResponse(raw);

			expect(parsed.costUsd).toBe(0.456);
			expect(parsed.sessionId).toBe("sess-xyz789");
		});
	});

	describe("UNIT-035: Malformed outer JSON throws descriptive error", () => {
		it("should throw when the outer JSON is not valid", () => {
			expect(() => parseClaudeResponse("not json at all")).toThrow(/failed to parse claude cli output/i);
		});

		it("should throw when the input is empty", () => {
			expect(() => parseClaudeResponse("")).toThrow(/failed to parse claude cli output/i);
		});
	});

	describe("UNIT-036: Missing result and structured_output throws descriptive error", () => {
		it("should throw when both result and structured_output are missing", () => {
			const raw = JSON.stringify({
				type: "result",
				subtype: "success",
				is_error: false,
			});

			expect(() => parseClaudeResponse(raw)).toThrow(/missing "result" and "structured_output"/i);
		});

		it("should throw when result is not a string and structured_output is absent", () => {
			const raw = JSON.stringify({
				type: "result",
				subtype: "success",
				is_error: false,
				result: 42,
				session_id: "s",
				cost_usd: 0,
			});

			expect(() => parseClaudeResponse(raw)).toThrow(/missing "result" and "structured_output"/i);
		});
	});

	describe("UNIT-037: Malformed inner JSON throws descriptive error", () => {
		it("should throw when result contains invalid JSON and no structured_output", () => {
			const raw = JSON.stringify({
				type: "result",
				subtype: "success",
				cost_usd: 0.01,
				is_error: false,
				result: "this is not json",
				session_id: "s",
			});

			expect(() => parseClaudeResponse(raw)).toThrow(/failed to parse inner result json/i);
		});
	});

	describe("UNIT-038: Empty spec in response fails validation", () => {
		it("should report validation error when spec is empty", () => {
			const parsed = {
				spec: "",
				changelog: "some changelog",
				commitMessage: "some commit",
				costUsd: 0,
				sessionId: "s",
			};

			const result = validateResponse(parsed);

			expect(result.valid).toBe(false);
			expect(result.errors).toContain("spec must not be empty");
		});
	});

	describe("UNIT-039: Empty changelog in response fails validation", () => {
		it("should report validation error when changelog is empty", () => {
			const parsed = {
				spec: "some spec",
				changelog: "",
				commitMessage: "some commit",
				costUsd: 0,
				sessionId: "s",
			};

			const result = validateResponse(parsed);

			expect(result.valid).toBe(false);
			expect(result.errors).toContain("changelog must not be empty");
		});

		it("should report multiple errors when both spec and changelog are empty", () => {
			const parsed = {
				spec: "",
				changelog: "",
				commitMessage: "msg",
				costUsd: 0,
				sessionId: "s",
			};

			const result = validateResponse(parsed);

			expect(result.valid).toBe(false);
			expect(result.errors).toHaveLength(2);
		});

		it("should pass validation when all fields are non-empty", () => {
			const parsed = {
				spec: "spec",
				changelog: "changelog",
				commitMessage: "msg",
				costUsd: 0.01,
				sessionId: "s",
			};

			const result = validateResponse(parsed);

			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});
	});

	describe("UNIT-041: Error response (is_error: true) throws descriptive error", () => {
		it("should throw when is_error is true", () => {
			const raw = JSON.stringify({
				type: "result",
				subtype: "error_max_turns",
				cost_usd: 0.01,
				is_error: true,
				result: "Something went wrong",
				session_id: "s",
			});

			expect(() => parseClaudeResponse(raw)).toThrow(/claude cli returned an error/i);
		});
	});
});
