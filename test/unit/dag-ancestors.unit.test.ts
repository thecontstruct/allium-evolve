import { describe, expect, it } from "vitest";
import type { CommitNode } from "../../src/dag/types.js";
import { collectAncestors } from "../../src/dag/ancestors.js";

function node(sha: string, parents: string[]): CommitNode {
	return {
		sha,
		parents,
		children: [],
		message: sha,
		authorDate: "",
		isTrunk: false,
	};
}

describe("dag/ancestors", () => {
	it("collectAncestors returns start sha and all ancestors", () => {
		const dag = new Map<string, CommitNode>();
		dag.set("A", node("A", []));
		dag.set("B", node("B", ["A"]));
		dag.set("C", node("C", ["B"]));
		const result = collectAncestors(dag, "C");
		expect(result.size).toBe(3);
		expect(result.has("A")).toBe(true);
		expect(result.has("B")).toBe(true);
		expect(result.has("C")).toBe(true);
	});

	it("collectAncestors with merge returns all ancestors from both parents", () => {
		const dag = new Map<string, CommitNode>();
		dag.set("A", node("A", []));
		dag.set("B", node("B", ["A"]));
		dag.set("C", node("C", ["A"]));
		dag.set("M", node("M", ["B", "C"]));
		const result = collectAncestors(dag, "M");
		expect(result.size).toBe(4);
		expect(result.has("A")).toBe(true);
		expect(result.has("B")).toBe(true);
		expect(result.has("C")).toBe(true);
		expect(result.has("M")).toBe(true);
	});

	it("collectAncestors for root returns only root", () => {
		const dag = new Map<string, CommitNode>();
		dag.set("A", node("A", []));
		const result = collectAncestors(dag, "A");
		expect(result.size).toBe(1);
		expect(result.has("A")).toBe(true);
	});
});
