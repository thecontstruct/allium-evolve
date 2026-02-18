import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	runEvolutionMock: vi.fn(),
	setupEvolutionMock: vi.fn(),
}));

vi.mock("../../src/evolution/orchestrator.js", () => ({
	runEvolution: mocks.runEvolutionMock,
	setupEvolution: mocks.setupEvolutionMock,
}));

describe("cli.ts session-limit handling", () => {
	const originalArgv = process.argv;
	let exitSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.resetModules();
		mocks.runEvolutionMock.mockReset();
		mocks.setupEvolutionMock.mockReset();
		process.exitCode = undefined;
		exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit should not be called for session-limit handling");
		}) as never);
	});

	afterEach(() => {
		process.argv = originalArgv;
		exitSpy.mockRestore();
	});

	describe("UNIT-057: CLI sets exitCode=2 on Claude session limit", () => {
		it("should set process.exitCode to 2 when runEvolution throws ClaudeSessionLimitError", async () => {
			const { ClaudeSessionLimitError } = await import("../../src/claude/errors.js");
			mocks.runEvolutionMock.mockRejectedValue(
				new ClaudeSessionLimitError("Claude usage limit reached. Try again later."),
			);

			const sigintListenersBefore = new Set(process.listeners("SIGINT"));
			process.argv = ["node", "cli", "--repo", "/tmp/repo"];

			await import("../../src/cli.js");

			await vi.waitFor(() => {
				expect(mocks.runEvolutionMock).toHaveBeenCalledTimes(1);
				expect(process.exitCode).toBe(2);
			});
			expect(exitSpy).not.toHaveBeenCalled();

			// Remove listeners added by cli.ts to keep test isolation.
			for (const listener of process.listeners("SIGINT")) {
				if (!sigintListenersBefore.has(listener)) {
					process.removeListener("SIGINT", listener);
				}
			}
		});
	});
});
