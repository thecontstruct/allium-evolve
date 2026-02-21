import { parseOriginalSha } from "../git/commit-metadata.js";
import { exec } from "../utils/exec.js";

// NOTE: These separators are embedded directly in git --format strings. If a commit
// message body contains the literal text "<<SEP>>" or "<<REC>>", parsing will be
// corrupted. This is an unlikely edge case in practice, but for a production-hardened
// implementation consider using NUL bytes (%x00) or higher-entropy separators.
const FIELD_SEP = "<<SEP>>";
const RECORD_SEP = "<<REC>>";
const WALK_LIMIT = 100;

export interface ResolveFromAlliumBranchResult {
	tipAlliumSha: string;
	startAfterSha: string;
	shaMap: Record<string, string>;
	commitsBeyondAnchor: number;
	lastProcessedMessage: string | null;
}

export async function resolveFromAlliumBranch(
	repoPath: string,
	alliumBranch: string,
): Promise<ResolveFromAlliumBranchResult | null> {
	if (!/^[a-zA-Z0-9._/-]+$/.test(alliumBranch)) {
		throw new Error(`Invalid allium branch name: '${alliumBranch}'. Branch names must match [a-zA-Z0-9._/-]+.`);
	}

	try {
		await exec(`git rev-parse --verify refs/heads/${alliumBranch}`, { cwd: repoPath });
	} catch {
		return null;
	}

	const { stdout: tipSha } = await exec(`git rev-parse refs/heads/${alliumBranch}`, {
		cwd: repoPath,
	});
	const tipAlliumSha = tipSha.trim();

	const format = `%H${FIELD_SEP}%B${RECORD_SEP}`;
	const { stdout } = await exec(
		`git log --first-parent -n ${WALK_LIMIT} ${tipAlliumSha} --format="${format}"`,
		{ cwd: repoPath },
	);
	const records = stdout.split(RECORD_SEP).filter((r) => r.trim().length > 0);

	let anchorOriginalSha: string | null = null;
	let commitsBeyondAnchor = 0;

	for (const record of records) {
		const idx = record.indexOf(FIELD_SEP);
		if (idx === -1) continue;
		const body = record.slice(idx + FIELD_SEP.length);
		const originalSha = parseOriginalSha(body);
		if (originalSha) {
			anchorOriginalSha = originalSha;
			break;
		}
		commitsBeyondAnchor += 1;
	}

	if (!anchorOriginalSha) {
		throw new Error(
			`No Original: tag found in last ${WALK_LIMIT} commits of allium branch '${alliumBranch}'. The branch may be corrupt or was not created by allium-evolve.`,
		);
	}

	const shaMap = await buildShaMapFromAlliumBranch(repoPath, tipAlliumSha);

	let lastProcessedMessage: string | null = null;
	try {
		const { stdout: msg } = await exec(`git log -1 --format=%s ${anchorOriginalSha}`, {
			cwd: repoPath,
		});
		lastProcessedMessage = msg.trim() || null;
	} catch {
		lastProcessedMessage = null;
	}

	return {
		tipAlliumSha,
		startAfterSha: anchorOriginalSha,
		shaMap,
		commitsBeyondAnchor,
		lastProcessedMessage,
	};
}

/**
 * Walks the full allium branch history from tipAlliumSha to build a complete
 * original→allium SHA map. No walk limit is applied; on very large allium branches
 * this may be slow. The map uses first-seen semantics (tip-to-root order) so the
 * most recent allium SHA wins for a given original SHA.
 */
export async function buildShaMapFromAlliumBranch(
	repoPath: string,
	tipAlliumSha: string,
): Promise<Record<string, string>> {
	const format = `%H${FIELD_SEP}%B${RECORD_SEP}`;
	const { stdout } = await exec(`git log ${tipAlliumSha} --format="${format}"`, { cwd: repoPath });
	const records = stdout.split(RECORD_SEP).filter((r) => r.trim().length > 0);
	const shaMap: Record<string, string> = {};

	for (const record of records) {
		const idx = record.indexOf(FIELD_SEP);
		if (idx === -1) continue;
		const alliumSha = record.slice(0, idx).trim();
		const body = record.slice(idx + FIELD_SEP.length);
		const originalSha = parseOriginalSha(body);
		if (originalSha && !shaMap[originalSha]) {
			shaMap[originalSha] = alliumSha;
		}
	}

	return shaMap;
}
