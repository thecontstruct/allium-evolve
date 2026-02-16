import { estimateTokens } from "../utils/tokens.js";

const MASTER_KEY = "_master";
const SPEC_PREFIX = "spec/";
const SPEC_EXT = ".allium";

function validateModulePath(modulePath: string): void {
	if (modulePath.startsWith("/")) {
		throw new Error(`Module path must be relative: ${modulePath}`);
	}
	if (modulePath.includes("..")) {
		throw new Error(`Module path must not contain '..': ${modulePath}`);
	}
	if (!modulePath.endsWith(SPEC_EXT)) {
		throw new Error(`Module path must end with '${SPEC_EXT}': ${modulePath}`);
	}
}

function sourcePathToModulePath(sourcePath: string): string {
	const parts = sourcePath.split("/");
	if (parts.length <= 1) {
		return `${MASTER_KEY}${SPEC_EXT}`;
	}
	const dir = parts.slice(0, -1).join("/");
	return `${dir}${SPEC_EXT}`;
}

export function resolveModulePath(sourcePaths: string[], knownModules: Set<string>): string {
	for (const sp of sourcePaths) {
		let candidate = sourcePathToModulePath(sp);

		while (candidate !== `${MASTER_KEY}${SPEC_EXT}`) {
			if (knownModules.has(candidate)) {
				return candidate;
			}
			const parts = candidate.replace(SPEC_EXT, "").split("/");
			if (parts.length <= 1) {
				break;
			}
			candidate = `${parts.slice(0, -1).join("/")}${SPEC_EXT}`;
		}
	}

	return `${MASTER_KEY}${SPEC_EXT}`;
}

export interface SpecStore {
	getMasterSpec(): string;
	getModuleSpec(modulePath: string): string | undefined;
	getAllModules(): Map<string, string>;
	getRelevantSpecs(changedPaths: string[]): { master: string; modules: Map<string, string> };
	setModuleSpec(modulePath: string, content: string): void;
	setMasterSpec(content: string): void;
	toFileMap(): Map<string, string>;
	totalTokens(): number;
	toSerializable(): Record<string, string>;
}

export function createSpecStore(initial?: Record<string, string>): SpecStore {
	const modules = new Map<string, string>();
	let masterSpec = "";

	if (initial) {
		for (const [key, value] of Object.entries(initial)) {
			if (key === `${MASTER_KEY}${SPEC_EXT}` || key === MASTER_KEY) {
				masterSpec = value;
			} else {
				modules.set(key, value);
			}
		}
	}

	return {
		getMasterSpec(): string {
			return masterSpec;
		},

		getModuleSpec(modulePath: string): string | undefined {
			return modules.get(modulePath);
		},

		getAllModules(): Map<string, string> {
			return new Map(modules);
		},

		getRelevantSpecs(changedPaths: string[]): { master: string; modules: Map<string, string> } {
			const relevant = new Map<string, string>();
			const knownModules = new Set(modules.keys());

			const seen = new Set<string>();
			for (const changed of changedPaths) {
				const modPath = resolveModulePath([changed], knownModules);
				if (modPath !== `${MASTER_KEY}${SPEC_EXT}` && !seen.has(modPath)) {
					seen.add(modPath);
					const content = modules.get(modPath);
					if (content) {
						relevant.set(modPath, content);
					}
				}
			}

			return { master: masterSpec, modules: relevant };
		},

		setModuleSpec(modulePath: string, content: string): void {
			validateModulePath(modulePath);
			modules.set(modulePath, content);
		},

		setMasterSpec(content: string): void {
			masterSpec = content;
		},

		toFileMap(): Map<string, string> {
			const fileMap = new Map<string, string>();
			fileMap.set(`${SPEC_PREFIX}${MASTER_KEY}${SPEC_EXT}`, masterSpec);
			for (const [key, value] of modules) {
				fileMap.set(`${SPEC_PREFIX}${key}`, value);
			}
			return fileMap;
		},

		totalTokens(): number {
			let total = estimateTokens(masterSpec);
			for (const content of modules.values()) {
				total += estimateTokens(content);
			}
			return total;
		},

		toSerializable(): Record<string, string> {
			const result: Record<string, string> = {};
			result[`${MASTER_KEY}${SPEC_EXT}`] = masterSpec;
			for (const [key, value] of modules) {
				result[key] = value;
			}
			return result;
		},
	};
}

export function specStoreFromSingleSpec(spec: string): SpecStore {
	return createSpecStore({ [`${MASTER_KEY}${SPEC_EXT}`]: spec });
}
