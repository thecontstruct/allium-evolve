export class ClaudeSessionLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ClaudeSessionLimitError";
	}
}

export class ClaudeRateLimitError extends Error {
	readonly retryAfterMs?: number;

	constructor(message: string, retryAfterMs?: number) {
		super(message);
		this.name = "ClaudeRateLimitError";
		this.retryAfterMs = retryAfterMs;
	}
}

export type ClaudeErrorClassification = "session-limit" | "transient" | {
	type: "rate-limit";
	retryAfterMs?: number;
};

export function classifyClaudeError(err: Error): ClaudeErrorClassification {
	const message = err.message.toLowerCase();

	if (message.includes("claude usage limit reached")) {
		return "session-limit";
	}

	if (message.includes("rate limit") || message.includes("rate_limit_error") || message.includes("429")) {
		const retryAfterMatch = err.message.match(/retry.?after[:\s]+(\d+)/i);
		const retryAfterMs = retryAfterMatch?.[1] ? Number.parseInt(retryAfterMatch[1], 10) * 1000 : undefined;
		return {
			type: "rate-limit",
			retryAfterMs,
		};
	}

	return "transient";
}
