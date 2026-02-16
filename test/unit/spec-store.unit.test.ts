import { describe, expect, it } from "vitest";
import {
	createSpecStore,
	resolveModulePath,
	specStoreFromSingleSpec,
} from "../../src/spec/store.js";

describe("SpecStore", () => {
	describe("createSpecStore", () => {
		it("should initialize with empty state", () => {
			const store = createSpecStore();
			expect(store.getMasterSpec()).toBe("");
			expect(store.getAllModules().size).toBe(0);
		});

		it("should initialize from a record", () => {
			const store = createSpecStore({
				"_master.allium": "master content",
				"entities/user.allium": "user spec",
				"entities/team.allium": "team spec",
			});
			expect(store.getMasterSpec()).toBe("master content");
			expect(store.getAllModules().size).toBe(2);
			expect(store.getModuleSpec("entities/user.allium")).toBe("user spec");
		});

		it("should accept _master as a key alias", () => {
			const store = createSpecStore({ _master: "from alias" });
			expect(store.getMasterSpec()).toBe("from alias");
		});
	});

	describe("specStoreFromSingleSpec", () => {
		it("should create a store with the spec as master", () => {
			const store = specStoreFromSingleSpec("entity User { name: String }");
			expect(store.getMasterSpec()).toBe("entity User { name: String }");
			expect(store.getAllModules().size).toBe(0);
		});
	});

	describe("setModuleSpec / getModuleSpec", () => {
		it("should store and retrieve module specs", () => {
			const store = createSpecStore();
			store.setModuleSpec("entities/user.allium", "user content");
			expect(store.getModuleSpec("entities/user.allium")).toBe("user content");
		});

		it("should reject absolute paths", () => {
			const store = createSpecStore();
			expect(() => store.setModuleSpec("/absolute/path.allium", "content")).toThrow(/must be relative/);
		});

		it("should reject paths with directory traversal", () => {
			const store = createSpecStore();
			expect(() => store.setModuleSpec("../escape.allium", "content")).toThrow(/must not contain/);
		});

		it("should reject paths without .allium extension", () => {
			const store = createSpecStore();
			expect(() => store.setModuleSpec("module.txt", "content")).toThrow(/must end with/);
		});
	});

	describe("setMasterSpec", () => {
		it("should update the master spec", () => {
			const store = createSpecStore();
			store.setMasterSpec("new master");
			expect(store.getMasterSpec()).toBe("new master");
		});
	});

	describe("toFileMap", () => {
		it("should produce paths prefixed with spec/", () => {
			const store = createSpecStore({
				"_master.allium": "master",
				"entities/user.allium": "user",
			});
			const fileMap = store.toFileMap();
			expect(fileMap.get("spec/_master.allium")).toBe("master");
			expect(fileMap.get("spec/entities/user.allium")).toBe("user");
			expect(fileMap.size).toBe(2);
		});
	});

	describe("totalTokens", () => {
		it("should return positive count for non-empty specs", () => {
			const store = createSpecStore({
				"_master.allium": "entity User { name: String }",
				"entities/user.allium": "entity UserPreferences { theme: String }",
			});
			expect(store.totalTokens()).toBeGreaterThan(0);
		});

		it("should return 0 for empty store", () => {
			const store = createSpecStore();
			expect(store.totalTokens()).toBe(0);
		});
	});

	describe("toSerializable", () => {
		it("should produce a record that can reconstruct the store", () => {
			const store = createSpecStore({
				"_master.allium": "master content",
				"entities/user.allium": "user spec",
			});
			const serialized = store.toSerializable();
			const restored = createSpecStore(serialized);
			expect(restored.getMasterSpec()).toBe("master content");
			expect(restored.getModuleSpec("entities/user.allium")).toBe("user spec");
		});
	});

	describe("getRelevantSpecs", () => {
		it("should return master and matching module specs", () => {
			const store = createSpecStore({
				"_master.allium": "master",
				"entities/user.allium": "user spec",
				"entities/team.allium": "team spec",
				"routes/auth.allium": "auth spec",
			});
			const result = store.getRelevantSpecs(["entities/user/profile.ts"]);
			expect(result.master).toBe("master");
			expect(result.modules.size).toBe(1);
			expect(result.modules.get("entities/user.allium")).toBe("user spec");
		});

		it("should return master only when no modules match", () => {
			const store = createSpecStore({
				"_master.allium": "master",
				"entities/user.allium": "user spec",
			});
			const result = store.getRelevantSpecs(["unknown/file.ts"]);
			expect(result.master).toBe("master");
			expect(result.modules.size).toBe(0);
		});

		it("should match multiple changed paths to their modules", () => {
			const store = createSpecStore({
				"_master.allium": "master",
				"entities.allium": "entities spec",
				"routes.allium": "routes spec",
			});
			const result = store.getRelevantSpecs(["entities/user.ts", "routes/auth.ts"]);
			expect(result.modules.size).toBe(2);
		});
	});
});

describe("resolveModulePath", () => {
	it("should resolve to exact matching module", () => {
		const modules = new Set(["entities/user.allium", "entities/team.allium"]);
		expect(resolveModulePath(["entities/user/profile.ts"], modules)).toBe("entities/user.allium");
	});

	it("should fall back to parent directory module", () => {
		const modules = new Set(["entities.allium"]);
		expect(resolveModulePath(["entities/user/deep/file.ts"], modules)).toBe("entities.allium");
	});

	it("should fall back to master when no module matches", () => {
		const modules = new Set(["entities.allium"]);
		expect(resolveModulePath(["unknown/file.ts"], modules)).toBe("_master.allium");
	});

	it("should handle root-level files", () => {
		const modules = new Set(["entities.allium"]);
		expect(resolveModulePath(["root-file.ts"], modules)).toBe("_master.allium");
	});
});
