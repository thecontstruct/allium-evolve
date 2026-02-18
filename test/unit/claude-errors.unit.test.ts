import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ExecResult, exec } from "../../src/utils/exec.js";
import {
	ClaudeRateLimitError,
	ClaudeSessionLimitError,
	classifyClaudeError,
} from "../../src/claude/errors.js";
import { invokeClaudeForStep } from "../../src/claude/runner.js";

vi.mock("../../src/utils/exec.js", () => ({
	exec: vi.fn(),
}));

describe("claude/errors.ts", () => {
	describe("UNIT-050: classifyClaudeError categorizes session limit errors", () => {
		it("returns session-limit when Claude usage limit is reached", () => {
			const err = new Error("Claude usage limit reached. Try again later.");
			expect(classifyClaudeError(err)).toBe("session-limit");
		});
	});

	describe("UNIT-051: classifyClaudeError categorizes rate limit errors", () => {
		it("returns rate-limit and extracts retry-after seconds", () => {
			const err = new Error("429 rate_limit_error: retry-after: 120");
			const result = classifyClaudeError(err);
			expect(typeof result).toBe("object");
			expect(result).toEqual({
				type: "rate-limit",
				retryAfterMs: 120_000,
			});
		});

		it("returns rate-limit without retryAfterMs when value is absent", () => {
			const err = new Error("429 rate limit reached");
			const result = classifyClaudeError(err);
			expect(result).toEqual({
				type: "rate-limit",
				retryAfterMs: undefined,
			});
		});
	});

	describe("UNIT-052: classifyClaudeError leaves unknown errors as transient", () => {
		it("returns transient for non-limit errors", () => {
			const err = new Error("Validation failed: spec must not be empty");
			expect(classifyClaudeError(err)).toBe("transient");
		});
	});
});

describe("claude/runner.ts session-limit handling", () => {
	const execMock = vi.mocked(exec);

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("UNIT-053: session-limit errors bypass retry loop", () => {
		it("throws ClaudeSessionLimitError immediately and does not consume retries", async () => {
			execMock.mockRejectedValue(new Error("Command failed: claude\nClaude usage limit reached"));

			await expect(
				invokeClaudeForStep({
					systemPrompt: "system",
					userPrompt: "user",
					model: "sonnet",
					workingDirectory: "/workspace",
					alliumSkillsPath: "/workspace/.claude/skills/allium",
					maxRetries: 5,
				}),
			).rejects.toBeInstanceOf(ClaudeSessionLimitError);

			expect(execMock).toHaveBeenCalledTimes(1);
		});
	});

	describe("UNIT-054: excessive rate-limit retries throw typed error", () => {
		it("throws ClaudeRateLimitError after maxRateLimitRetries is reached", async () => {
			execMock.mockRejectedValue(new Error("Command failed: claude\n429 rate_limit_error retry-after: 1"));

			await expect(
				invokeClaudeForStep({
					systemPrompt: "system",
					userPrompt: "user",
					model: "sonnet",
					workingDirectory: "/workspace",
					alliumSkillsPath: "/workspace/.claude/skills/allium",
					maxRetries: 5,
					maxRateLimitRetries: 1,
					rateLimitRetryDelayMs: 1,
				}),
			).rejects.toBeInstanceOf(ClaudeRateLimitError);

			expect(execMock).toHaveBeenCalledTimes(1);
		});
	});

	describe("UNIT-055: transient errors still use maxRetries", () => {
		it("retries transient failures up to maxRetries + 1 attempts", async () => {
			execMock.mockRejectedValue(new Error("Command failed: claude\nUnexpected transport error"));

			await expect(
				invokeClaudeForStep({
					systemPrompt: "system",
					userPrompt: "user",
					model: "sonnet",
					workingDirectory: "/workspace",
					alliumSkillsPath: "/workspace/.claude/skills/allium",
					maxRetries: 2,
				}),
			).rejects.toThrow(/Claude invocation failed after 3 attempts/i);

			expect(execMock).toHaveBeenCalledTimes(3);
		});
	});

	describe("UNIT-056: rate-limit retries do not consume maxRetries", () => {
		it("succeeds after rate-limit waits without incrementing attempt budget", async () => {
			execMock
				.mockRejectedValueOnce(new Error("429 rate limit retry-after: 1"))
				.mockResolvedValueOnce({
					stdout: JSON.stringify({
						type: "result",
						subtype: "success",
						total_cost_usd: 0.2,
						is_error: false,
						structured_output: {
							spec: "spec",
							changelog: "change",
							commitMessage: "msg",
						},
						session_id: "sess-1",
					}),
					stderr: "",
				} satisfies ExecResult);

			const result = await invokeClaudeForStep({
				systemPrompt: "system",
				userPrompt: "user",
				model: "sonnet",
				workingDirectory: "/workspace",
				alliumSkillsPath: "/workspace/.claude/skills/allium",
				maxRetries: 0,
				maxRateLimitRetries: 2,
				rateLimitRetryDelayMs: 1,
			});

			expect(result.spec).toBe("spec");
			expect(execMock).toHaveBeenCalledTimes(2);
		});
	});
});
