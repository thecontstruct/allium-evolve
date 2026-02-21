import { parseOriginalSha } from "../git/commit-metadata.js";
import { exec } from "../utils/exec.js";

const FIELD_SEP = "<<SEP>>";
const RECORD_SEP = "<<REC>>";

export async function resolveSeedAlliumSha(
	repoPath: string,
	startAfter: string,
	alliumBranch: string,
	seedSpecFrom?: string,
): Promise<string> {
	if (seedSpecFrom) {
		await exec(`git rev-parse --verify ${seedSpecFrom}`, { cwd: repoPath });
		const { stdout: body } = await exec(`git log -1 --format=%B ${seedSpecFrom}`, { cwd: repoPath });
		const embedded = parseOriginalSha(body);
		if (embedded !== startAfter) {
			throw new Error(
				`Seed commit ${seedSpecFrom.slice(0, 8)} maps to original ${embedded ?? "unknown"}, but --start-after is ${startAfter.slice(0, 8)}. Provide the correct --seed-spec or omit it to auto-resolve.`,
			);
		}
		return seedSpecFrom;
	}

	const format = `%H${FIELD_SEP}%B${RECORD_SEP}`;
	const { stdout } = await exec(`git log ${alliumBranch} --format="${format}"`, { cwd: repoPath });
	const records = stdout.split(RECORD_SEP).filter((r) => r.trim().length > 0);

	for (const record of records) {
		const idx = record.indexOf(FIELD_SEP);
		if (idx === -1) continue;
		const alliumSha = record.slice(0, idx).trim();
		const body = record.slice(idx + FIELD_SEP.length);
		const originalSha = parseOriginalSha(body);
		if (originalSha === startAfter) {
			return alliumSha;
		}
	}

	throw new Error(
		`Could not find allium commit for original SHA ${startAfter.slice(0, 8)} on branch ${alliumBranch}. Use --seed-spec to provide the allium SHA directly.`,
	);
}

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
