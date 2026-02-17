import { describe, expect, it } from "vitest";
import { GracefulShutdownError, ShutdownSignal } from "../../src/shutdown.js";

describe("ShutdownSignal", () => {
	it("starts with requested = false", () => {
		const signal = new ShutdownSignal();
		expect(signal.requested).toBe(false);
	});

	it("sets requested = true after request()", () => {
		const signal = new ShutdownSignal();
		signal.request();
		expect(signal.requested).toBe(true);
	});

	it("request() is idempotent", () => {
		const signal = new ShutdownSignal();
		signal.request();
		signal.request();
		expect(signal.requested).toBe(true);
	});

	it("assertContinue() does nothing when not requested", () => {
		const signal = new ShutdownSignal();
		expect(() => signal.assertContinue()).not.toThrow();
	});

	it("assertContinue() throws GracefulShutdownError when requested", () => {
		const signal = new ShutdownSignal();
		signal.request();
		expect(() => signal.assertContinue()).toThrow(GracefulShutdownError);
	});
});

describe("GracefulShutdownError", () => {
	it("is an instance of Error", () => {
		const err = new GracefulShutdownError();
		expect(err).toBeInstanceOf(Error);
	});

	it("has the correct name", () => {
		const err = new GracefulShutdownError();
		expect(err.name).toBe("GracefulShutdownError");
	});

	it("can be distinguished from generic errors via instanceof", () => {
		const shutdownErr = new GracefulShutdownError();
		const genericErr = new Error("something else");
		expect(shutdownErr instanceof GracefulShutdownError).toBe(true);
		expect(genericErr instanceof GracefulShutdownError).toBe(false);
	});
});
