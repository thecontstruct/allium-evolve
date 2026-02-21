import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildDag } from "../../src/dag/builder.js";
import { decompose } from "../../src/dag/segments.js";
import { identifyTrunk } from "../../src/dag/trunk.js";
import type { CommitNode, Segment } from "../../src/dag/types.js";

const FIXTURE_REPO = resolve(import.meta.dirname, "../fixtures/repo");

describe("dag module", () => {
	let dag: Map<string, CommitNode>;
	let segments: Segment[];

	/** Look up a commit by its message prefix (e.g. "A:", "M1:"). */
	function nodeByMsg(prefix: string): CommitNode {
		for (const node of dag.values()) {
			if (node.message.startsWith(prefix)) {
				return node;
			}
		}
		throw new Error(`No commit with message prefix: ${prefix}`);
	}

	function sha(prefix: string): string {
		return nodeByMsg(prefix).sha;
	}

	/** Find the segment that contains a given SHA. */
	function segmentContaining(commitSha: string): Segment {
		const seg = segments.find((s) => s.commits.includes(commitSha));
		if (!seg) {
			throw new Error(`No segment contains SHA ${commitSha}`);
		}
		return seg;
	}

	beforeAll(async () => {
		dag = await buildDag(FIXTURE_REPO);
		await identifyTrunk(dag, FIXTURE_REPO, "main");
		segments = decompose(dag);
	});

	// ── UNIT-004 ────────────────────────────────────────────────────────
	describe("UNIT-004: buildDag produces correct CommitNode map", () => {
		it("should contain all 30 commits from fixture repo", () => {
			expect(dag.size).toBe(30);
		});

		it("should produce valid CommitNode objects", () => {
			for (const node of dag.values()) {
				expect(node.sha).toBeTruthy();
				expect(node.message).toBeTruthy();
				expect(Array.isArray(node.parents)).toBe(true);
				expect(Array.isArray(node.children)).toBe(true);
				expect(typeof node.isTrunk).toBe("boolean");
			}
		});

		it("should identify root commit A with no parents", () => {
			const rootA = nodeByMsg("A:");
			expect(rootA.parents).toHaveLength(0);
		});

		it("should identify merge commits M1 and M2 with two parents each", () => {
			expect(nodeByMsg("M1:").parents).toHaveLength(2);
			expect(nodeByMsg("M2:").parents).toHaveLength(2);
		});
	});

	// ── UNIT-005 ────────────────────────────────────────────────────────
	describe("UNIT-005: identifyTrunk marks correct nodes as trunk", () => {
		const trunkPrefixes = [
			"A:", "B:", "C:", "M1:", "D:", "E:", "M2:", "F:",
			"G:", "H:", "I:", "J:", "K:", "L:", "M:", "N:", "O:", "P:", "Q:", "R:", "S:", "T:", "U:",
		];
		const nonTrunkPrefixes = ["X1:", "X2:", "Y1:", "Y2:", "Y3:", "Z1:", "Z2:"];

		it("should mark exactly 23 commits as trunk", () => {
			const trunkCount = [...dag.values()].filter((n) => n.isTrunk).length;
			expect(trunkCount).toBe(23);
		});

		it.each(trunkPrefixes)("should mark %s as trunk", (prefix) => {
			expect(nodeByMsg(prefix).isTrunk).toBe(true);
		});

		it.each(nonTrunkPrefixes)("should NOT mark %s as trunk", (prefix) => {
			expect(nodeByMsg(prefix).isTrunk).toBe(false);
		});
	});

	// ── UNIT-006 ────────────────────────────────────────────────────────
	describe("UNIT-006: decomposition produces correct number of segments", () => {
		it("should produce exactly 6 segments", () => {
			expect(segments).toHaveLength(6);
		});

		it("should have 3 trunk, 2 branch, and 1 dead-end segment", () => {
			const byType = (t: string) => segments.filter((s) => s.type === t).length;
			expect(byType("trunk")).toBe(3);
			expect(byType("branch")).toBe(2);
			expect(byType("dead-end")).toBe(1);
		});
	});

	// ── UNIT-007 ────────────────────────────────────────────────────────
	describe("UNIT-007: trunk segments contain correct commits in order", () => {
		it("first trunk segment contains A, B, C in order", () => {
			const seg = segmentContaining(sha("A:"));
			expect(seg.type).toBe("trunk");
			expect(seg.commits).toEqual([sha("A:"), sha("B:"), sha("C:")]);
		});

		it("second trunk segment contains M1, D, E in order", () => {
			const seg = segmentContaining(sha("M1:"));
			expect(seg.type).toBe("trunk");
			expect(seg.commits).toEqual([sha("M1:"), sha("D:"), sha("E:")]);
		});

		it("third trunk segment contains M2 through U in order", () => {
			const seg = segmentContaining(sha("M2:"));
			expect(seg.type).toBe("trunk");
			expect(seg.commits[0]).toBe(sha("M2:"));
			expect(seg.commits[1]).toBe(sha("F:"));
			expect(seg.commits[seg.commits.length - 1]).toBe(sha("U:"));
			expect(seg.commits).toHaveLength(17);
		});
	});

	// ── UNIT-008 ────────────────────────────────────────────────────────
	describe("UNIT-008: branch segments have correct forkFrom and mergesInto", () => {
		it("branch-x segment forks from C and merges into M1", () => {
			const seg = segmentContaining(sha("X1:"));
			expect(seg.type).toBe("branch");
			expect(seg.commits).toEqual([sha("X1:"), sha("X2:")]);
			expect(seg.forkFrom).toBe(sha("C:"));
			expect(seg.mergesInto).toBe(sha("M1:"));
		});

		it("branch-y segment forks from C and merges into M2", () => {
			const seg = segmentContaining(sha("Y1:"));
			expect(seg.type).toBe("branch");
			expect(seg.commits).toEqual([sha("Y1:"), sha("Y2:"), sha("Y3:")]);
			expect(seg.forkFrom).toBe(sha("C:"));
			expect(seg.mergesInto).toBe(sha("M2:"));
		});
	});

	// ── UNIT-009 ────────────────────────────────────────────────────────
	describe("UNIT-009: dead-end segment identified correctly", () => {
		it("should contain Z1 and Z2", () => {
			const seg = segmentContaining(sha("Z1:"));
			expect(seg.type).toBe("dead-end");
			expect(seg.commits).toEqual([sha("Z1:"), sha("Z2:")]);
		});

		it("should fork from E and have no merge target", () => {
			const seg = segmentContaining(sha("Z1:"));
			expect(seg.forkFrom).toBe(sha("E:"));
			expect(seg.mergesInto).toBeNull();
		});
	});

	// ── UNIT-010 ────────────────────────────────────────────────────────
	describe("UNIT-010: topological order respects dependencies", () => {
		it("every segment's dependsOn entries appear earlier in the array", () => {
			const indexById = new Map<string, number>();
			segments.forEach((seg, i) => indexById.set(seg.id, i));

			for (const seg of segments) {
				for (const depId of seg.dependsOn) {
					const depIndex = indexById.get(depId);
					const segIndex = indexById.get(seg.id);
					expect(depIndex).toBeDefined();
					expect(segIndex).toBeDefined();
					expect(
						depIndex! < segIndex!,
						`${seg.id} depends on ${depId}, but ${depId} (index ${depIndex}) appears after ${seg.id} (index ${segIndex})`,
					).toBe(true);
				}
			}
		});

		it("trunk segments have correct dependsOn relationships", () => {
			const trunkSegs = segments.filter((s) => s.type === "trunk");
			// Sort by position in the topo-ordered array
			trunkSegs.sort((a, b) => segments.findIndex((s) => s.id === a.id) - segments.findIndex((s) => s.id === b.id));

			// First trunk segment has no dependencies
			expect(trunkSegs[0]!.dependsOn).toEqual([]);

			// Second trunk segment depends on first trunk + X-branch
			const xBranch = segmentContaining(sha("X1:"));
			expect(trunkSegs[1]!.dependsOn).toContain(trunkSegs[0]!.id);
			expect(trunkSegs[1]!.dependsOn).toContain(xBranch.id);

			// Third trunk segment depends on second trunk + Y-branch
			const yBranch = segmentContaining(sha("Y1:"));
			expect(trunkSegs[2]!.dependsOn).toContain(trunkSegs[1]!.id);
			expect(trunkSegs[2]!.dependsOn).toContain(yBranch.id);
		});

		it("branch and dead-end segments depend on their fork-source trunk segment", () => {
			const xBranch = segmentContaining(sha("X1:"));
			const yBranch = segmentContaining(sha("Y1:"));
			const deadEnd = segmentContaining(sha("Z1:"));

			const trunkWithC = segmentContaining(sha("C:"));
			const trunkWithE = segmentContaining(sha("E:"));

			expect(xBranch.dependsOn).toContain(trunkWithC.id);
			expect(yBranch.dependsOn).toContain(trunkWithC.id);
			expect(deadEnd.dependsOn).toContain(trunkWithE.id);
		});
	});
});
