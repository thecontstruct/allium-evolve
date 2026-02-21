export const ORIGINAL_SHA_PREFIX = "Original: ";

export const ORIGINAL_SHA_REGEX = /^Original:\s+([a-f0-9]{40})/m;

export function parseOriginalSha(commitBody: string): string | null {
	const match = commitBody.match(ORIGINAL_SHA_REGEX);
	return match ? match[1]! : null;
}

export function formatOriginalLine(originalSha: string, originalMessage: string): string {
	return `${ORIGINAL_SHA_PREFIX}${originalSha} "${originalMessage}"`;
}
