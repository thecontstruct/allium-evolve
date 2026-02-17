import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EvolutionConfig } from "../config.js";
import type { Segment } from "../dag/types.js";
import type {
	CompletedMerge,
	CompletedReconciliation,
	CompletedStep,
	EvolutionState,
	SegmentProgress,
} from "./types.js";

export class StateTracker {
	private state!: EvolutionState;
	private stateFile: string;

	constructor(stateFile: string) {
		this.stateFile = stateFile;
	}

	initState(config: EvolutionConfig, segments: Segment[], rootCommit: string): void {
		const segmentProgress: Record<string, SegmentProgress> = {};
		for (const seg of segments) {
			segmentProgress[seg.id] = {
				status: "pending",
				completedSteps: [],
				currentSpec: "",
				currentChangelog: "",
			};
		}

		this.state = {
			version: 1,
			repoPath: config.repoPath,
			targetRef: config.targetRef,
			rootCommit,
			config,
			segments,
			segmentProgress,
			shaMap: {},
			completedMerges: [],
			alliumBranchHead: "",
			totalCostUsd: 0,
			totalSteps: 0,
			reconciliations: [],
			lastReconciliationStep: 0,
			lastReconciliationSha: undefined,
			cumulativeDiffTokensSinceLastReconciliation: 0,
		};
	}

	async load(): Promise<boolean> {
		try {
			const raw = await readFile(this.stateFile, "utf-8");
			this.state = JSON.parse(raw) as EvolutionState;
			return true;
		} catch {
			return false;
		}
	}

	async save(): Promise<void> {
		await mkdir(dirname(this.stateFile), { recursive: true });
		await writeFile(this.stateFile, JSON.stringify(this.state, null, 2), "utf-8");
	}

	recordStep(segmentId: string, step: CompletedStep, currentSpec: string, currentChangelog: string): void {
		const progress = this.state.segmentProgress[segmentId];
		if (!progress) {
			throw new Error(`Unknown segment: ${segmentId}`);
		}

		progress.completedSteps.push(step);
		progress.currentSpec = currentSpec;
		progress.currentChangelog = currentChangelog;

		if (progress.status === "pending") {
			progress.status = "in-progress";
		}

		this.state.shaMap[step.originalSha] = step.alliumSha;
		this.state.totalCostUsd += step.costUsd;
		this.state.totalSteps += 1;
	}

	recordMerge(merge: CompletedMerge): void {
		this.state.completedMerges.push(merge);
	}

	updateSegmentStatus(segmentId: string, status: SegmentProgress["status"]): void {
		const progress = this.state.segmentProgress[segmentId];
		if (!progress) {
			throw new Error(`Unknown segment: ${segmentId}`);
		}
		progress.status = status;
	}

	getSegmentProgress(segmentId: string): SegmentProgress | undefined {
		return this.state.segmentProgress[segmentId];
	}

	resetSegmentProgress(segmentId: string): void {
		const progress = this.state.segmentProgress[segmentId];
		if (!progress) {
			return;
		}
		for (const step of progress.completedSteps) {
			delete this.state.shaMap[step.originalSha];
			this.state.totalCostUsd -= step.costUsd;
			this.state.totalSteps -= 1;
		}
		progress.completedSteps = [];
		progress.currentSpec = "";
		progress.currentChangelog = "";
		progress.status = "pending";
	}

	lookupAlliumSha(originalSha: string): string | undefined {
		return this.state.shaMap[originalSha];
	}

	updateBranchHead(sha: string): void {
		this.state.alliumBranchHead = sha;
	}

	recordReconciliation(reconciliation: CompletedReconciliation, sha: string): void {
		this.state.reconciliations.push(reconciliation);
		this.state.lastReconciliationStep = this.state.totalSteps;
		this.state.lastReconciliationSha = sha;
		this.state.cumulativeDiffTokensSinceLastReconciliation = 0;
		this.state.totalCostUsd += reconciliation.costUsd;
	}

	addDiffTokens(tokens: number): void {
		this.state.cumulativeDiffTokensSinceLastReconciliation += tokens;
	}

	getReconciliationState(): {
		lastStep: number;
		lastSha: string | undefined;
		cumulativeDiffTokens: number;
	} {
		return {
			lastStep: this.state.lastReconciliationStep,
			lastSha: this.state.lastReconciliationSha,
			cumulativeDiffTokens: this.state.cumulativeDiffTokensSinceLastReconciliation,
		};
	}

	getState(): Readonly<EvolutionState> {
		return this.state;
	}
}
