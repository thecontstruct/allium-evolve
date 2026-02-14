export interface WindowState {
	commits: string[];
	focusIndex: number;
	processDepth: number;
	windowSize: number;
}

export function createWindow(windowSize: number, processDepth: number): WindowState {
	return {
		commits: [],
		focusIndex: 0,
		processDepth,
		windowSize,
	};
}

export function advance(state: WindowState, sha: string): WindowState {
	const commits = [...state.commits, sha];
	if (commits.length > state.windowSize) {
		const overflow = commits.length - state.windowSize;
		return {
			...state,
			commits: commits.slice(overflow),
			focusIndex: state.windowSize,
		};
	}
	return {
		...state,
		commits,
		focusIndex: commits.length,
	};
}

export function getFullDiffShas(state: WindowState): string[] {
	const count = Math.min(state.processDepth, state.commits.length);
	return state.commits.slice(state.commits.length - count);
}

export function getContextShas(state: WindowState): string[] {
	const fullDiffCount = Math.min(state.processDepth, state.commits.length);
	const contextEnd = state.commits.length - fullDiffCount;
	if (contextEnd <= 0) {
		return [];
	}
	return state.commits.slice(0, contextEnd);
}

export function seedWindow(state: WindowState, shas: string[]): WindowState {
	const trimmed = shas.length > state.windowSize ? shas.slice(shas.length - state.windowSize) : shas;

	return {
		...state,
		commits: [...trimmed],
		focusIndex: trimmed.length,
	};
}
