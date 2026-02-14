import { advance, createWindow, getContextShas, getFullDiffShas, seedWindow } from "../../src/evolution/window.js";

describe("evolution/window", () => {
	describe("UNIT-017: createWindow initializes empty state with correct config", () => {
		it("creates a window with empty commits and correct settings", () => {
			const state = createWindow(5, 2);
			expect(state.commits).toEqual([]);
			expect(state.focusIndex).toBe(0);
			expect(state.windowSize).toBe(5);
			expect(state.processDepth).toBe(2);
		});
	});

	describe("UNIT-018: advance adds commits and increments focusIndex", () => {
		it("adds a commit to the window", () => {
			const state = createWindow(5, 2);
			const next = advance(state, "abc123");
			expect(next.commits).toEqual(["abc123"]);
			expect(next.focusIndex).toBe(1);
		});

		it("adds multiple commits sequentially", () => {
			let state = createWindow(5, 2);
			state = advance(state, "sha1");
			state = advance(state, "sha2");
			state = advance(state, "sha3");
			expect(state.commits).toEqual(["sha1", "sha2", "sha3"]);
			expect(state.focusIndex).toBe(3);
		});
	});

	describe("UNIT-019: advance slides window when at capacity (drops oldest)", () => {
		it("drops the oldest commit when window is full", () => {
			let state = createWindow(3, 1);
			state = advance(state, "sha1");
			state = advance(state, "sha2");
			state = advance(state, "sha3");
			// Window is now full (3 commits, windowSize=3)
			state = advance(state, "sha4");
			expect(state.commits).toEqual(["sha2", "sha3", "sha4"]);
			expect(state.commits.length).toBe(3);
		});

		it("maintains windowSize invariant after many advances", () => {
			let state = createWindow(2, 1);
			for (let i = 0; i < 10; i++) {
				state = advance(state, `sha${i}`);
			}
			expect(state.commits.length).toBe(2);
			expect(state.commits).toEqual(["sha8", "sha9"]);
		});
	});

	describe("UNIT-020: getFullDiffShas returns tail processDepth commits", () => {
		it("returns the last processDepth commits", () => {
			let state = createWindow(5, 2);
			state = advance(state, "sha1");
			state = advance(state, "sha2");
			state = advance(state, "sha3");
			state = advance(state, "sha4");

			const fullDiff = getFullDiffShas(state);
			expect(fullDiff).toEqual(["sha3", "sha4"]);
		});

		it("returns only available commits when fewer than processDepth", () => {
			let state = createWindow(5, 3);
			state = advance(state, "sha1");

			const fullDiff = getFullDiffShas(state);
			expect(fullDiff).toEqual(["sha1"]);
		});
	});

	describe("UNIT-021: getContextShas returns remaining commits", () => {
		it("returns commits before the full-diff ones", () => {
			let state = createWindow(5, 2);
			state = advance(state, "sha1");
			state = advance(state, "sha2");
			state = advance(state, "sha3");
			state = advance(state, "sha4");

			const context = getContextShas(state);
			expect(context).toEqual(["sha1", "sha2"]);
		});

		it("returns empty array when all commits are in full-diff", () => {
			let state = createWindow(5, 3);
			state = advance(state, "sha1");
			state = advance(state, "sha2");

			const context = getContextShas(state);
			expect(context).toEqual([]);
		});
	});

	describe("UNIT-022: seedWindow pre-populates with context commits", () => {
		it("seeds the window with initial context SHAs", () => {
			const state = createWindow(5, 2);
			const seeded = seedWindow(state, ["ctx1", "ctx2", "ctx3"]);

			expect(seeded.commits).toEqual(["ctx1", "ctx2", "ctx3"]);
			expect(seeded.focusIndex).toBe(3);
		});

		it("respects windowSize when seeding with too many commits", () => {
			const state = createWindow(3, 1);
			const seeded = seedWindow(state, ["a", "b", "c", "d", "e"]);

			// Should keep the most recent (last) windowSize items
			expect(seeded.commits.length).toBe(3);
			expect(seeded.commits).toEqual(["c", "d", "e"]);
		});
	});

	describe("UNIT-023: processDepth > window content handled gracefully", () => {
		it("getFullDiffShas returns all commits when processDepth exceeds count", () => {
			let state = createWindow(10, 5);
			state = advance(state, "sha1");
			state = advance(state, "sha2");

			const fullDiff = getFullDiffShas(state);
			expect(fullDiff).toEqual(["sha1", "sha2"]);
		});

		it("getContextShas returns empty when processDepth exceeds count", () => {
			let state = createWindow(10, 5);
			state = advance(state, "sha1");
			state = advance(state, "sha2");

			const context = getContextShas(state);
			expect(context).toEqual([]);
		});

		it("still functions correctly after window fills up", () => {
			let state = createWindow(3, 5);
			state = advance(state, "sha1");
			state = advance(state, "sha2");
			state = advance(state, "sha3");

			const fullDiff = getFullDiffShas(state);
			expect(fullDiff).toEqual(["sha1", "sha2", "sha3"]);
			expect(getContextShas(state)).toEqual([]);
		});
	});
});
