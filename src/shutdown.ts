export class GracefulShutdownError extends Error {
	constructor() {
		super("Graceful shutdown requested");
		this.name = "GracefulShutdownError";
	}
}

export class ShutdownSignal {
	private _requested = false;

	get requested(): boolean {
		return this._requested;
	}

	request(): void {
		if (this._requested) return;
		this._requested = true;
		console.error("[allium-evolve] Graceful shutdown requested. Finishing current step(s) before exiting...");
	}

	assertContinue(): void {
		if (this._requested) {
			throw new GracefulShutdownError();
		}
	}
}
