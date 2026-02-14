import { parseGitLog } from "../git/log.js";
import type { CommitNode } from "./types.js";

export async function buildDag(repoPath: string): Promise<Map<string, CommitNode>> {
	return parseGitLog(repoPath);
}
