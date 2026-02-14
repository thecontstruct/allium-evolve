import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseGitLog } from "../../src/git/log.js";

const FIXTURE_REPO = resolve(import.meta.dirname, "../fixtures/repo");

describe("git/log.ts", () => {
	let nodes: Map<string, { sha: string; parents: string[]; children: string[]; message: string; isTrunk: boolean }>;

	beforeAll(async () => {
		nodes = await parseGitLog(FIXTURE_REPO);
	});

	describe("UNIT-001: Parse git log into CommitNode map", () => {
		it("should parse all commits from the fixture repo", () => {
			// Fixture has: A, B, C, X1, X2, Y1, Y2, Y3, M1, D, E, Z1, Z2, M2, F = 15
			expect(nodes.size).toBe(15);
		});

		it("should include SHA, message, and parents for each node", () => {
			for (const node of nodes.values()) {
				expect(node.sha).toBeTruthy();
				expect(node.message).toBeTruthy();
				expect(Array.isArray(node.parents)).toBe(true);
			}
		});
	});

	describe("UNIT-002: Parent/child linking", () => {
		it("should have root commit with no parents", () => {
			const roots = [...nodes.values()].filter((n) => n.parents.length === 0);
			expect(roots.length).toBe(1);
			expect(roots[0]!.message).toContain("A:");
		});

		it("should link children correctly", () => {
			for (const node of nodes.values()) {
				for (const parentSha of node.parents) {
					const parent = nodes.get(parentSha);
					expect(parent).toBeDefined();
					expect(parent!.children).toContain(node.sha);
				}
			}
		});

		it("should identify merge commits with multiple parents", () => {
			const merges = [...nodes.values()].filter((n) => n.parents.length > 1);
			expect(merges.length).toBe(2);
			const mergeMessages = merges.map((m) => m.message).sort();
			expect(mergeMessages[0]).toContain("M1:");
			expect(mergeMessages[1]).toContain("M2:");
		});
	});

	describe("UNIT-003: isTrunk defaults to false", () => {
		it("should initialize all nodes with isTrunk = false", () => {
			for (const node of nodes.values()) {
				expect(node.isTrunk).toBe(false);
			}
		});
	});
});
