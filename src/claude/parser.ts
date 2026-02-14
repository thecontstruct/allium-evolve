export interface ClaudeResponseEnvelope {
	type: string;
	subtype: string;
	cost_usd?: number;
	total_cost_usd?: number;
	duration_ms: number;
	is_error: boolean;
	result: string;
	structured_output?: Record<string, unknown>;
	session_id: string;
}

export interface ParsedClaudeResponse {
	spec: string;
	changelog: string;
	commitMessage: string;
	costUsd: number;
	sessionId: string;
}

export interface ParsedChunkResponse {
	specPatch: string;
	sectionsChanged: string[];
}

function parseEnvelope(rawOutput: string): ClaudeResponseEnvelope {
	let envelope: unknown;
	try {
		envelope = JSON.parse(rawOutput);
	} catch {
		throw new Error(`Failed to parse Claude CLI output as JSON: ${rawOutput.slice(0, 120)}`);
	}

	const env = envelope as Record<string, unknown>;

	if (env.is_error === true) {
		throw new Error(`Claude CLI returned an error (subtype: ${String(env.subtype)}): ${String(env.result ?? "")}`);
	}

	if (!env.structured_output && typeof env.result !== "string") {
		throw new Error('Missing "result" and "structured_output" fields in Claude CLI envelope');
	}

	return envelope as ClaudeResponseEnvelope;
}

function parseInnerJson<T>(resultStr: string): T {
	try {
		return JSON.parse(resultStr) as T;
	} catch {
		throw new Error(`Failed to parse inner result JSON: ${resultStr.slice(0, 120)}`);
	}
}

export function parseClaudeResponse(rawOutput: string): ParsedClaudeResponse {
	const envelope = parseEnvelope(rawOutput);
	const inner = envelope.structured_output
		? (envelope.structured_output as { spec: string; changelog: string; commitMessage: string })
		: parseInnerJson<{ spec: string; changelog: string; commitMessage: string }>(envelope.result);

	return {
		spec: inner.spec,
		changelog: inner.changelog,
		commitMessage: inner.commitMessage,
		costUsd: envelope.total_cost_usd ?? envelope.cost_usd ?? 0,
		sessionId: envelope.session_id,
	};
}

export function parseChunkResponse(rawOutput: string): ParsedChunkResponse {
	const envelope = parseEnvelope(rawOutput);
	const inner = envelope.structured_output
		? (envelope.structured_output as { specPatch: string; sectionsChanged: string[] })
		: parseInnerJson<{ specPatch: string; sectionsChanged: string[] }>(envelope.result);

	return {
		specPatch: inner.specPatch,
		sectionsChanged: inner.sectionsChanged,
	};
}

export function validateResponse(parsed: ParsedClaudeResponse): {
	valid: boolean;
	errors: string[];
} {
	const errors: string[] = [];

	if (!parsed.spec) {
		errors.push("spec must not be empty");
	}
	if (!parsed.changelog) {
		errors.push("changelog must not be empty");
	}
	if (!parsed.commitMessage) {
		errors.push("commitMessage must not be empty");
	}

	return { valid: errors.length === 0, errors };
}
