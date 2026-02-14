let _encoder: { encode: (text: string) => Uint32Array; free: () => void } | null = null;
let _initFailed = false;

function getEncoder() {
	if (_initFailed) {
		return null;
	}
	if (_encoder) {
		return _encoder;
	}

	try {
		// Dynamic require to handle environments where tiktoken isn't available
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const tiktoken = require("tiktoken") as typeof import("tiktoken");
		_encoder = tiktoken.encoding_for_model("gpt-4o");
		return _encoder;
	} catch {
		_initFailed = true;
		return null;
	}
}

function heuristicEstimate(text: string): number {
	if (text.length === 0) {
		return 0;
	}
	return Math.ceil(text.length / 4);
}

export function estimateTokens(text: string): number {
	if (text.length === 0) {
		return 0;
	}

	const encoder = getEncoder();
	if (encoder) {
		try {
			const tokens = encoder.encode(text);
			return tokens.length;
		} catch {
			return heuristicEstimate(text);
		}
	}

	return heuristicEstimate(text);
}
