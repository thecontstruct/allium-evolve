import { exec as cpExec, type ExecOptions } from "node:child_process";

export interface ExecResult {
	stdout: string;
	stderr: string;
}

export function exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		cpExec(command, { maxBuffer: 50 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
			if (error) {
				const err = new Error(`Command failed: ${command}\n${stderr}`) as Error & {
					stdout: string;
					stderr: string;
					code: number | undefined;
				};
				err.stdout = typeof stdout === "string" ? stdout : "";
				err.stderr = typeof stderr === "string" ? stderr : "";
				err.code = error.code;
				reject(err);
				return;
			}
			resolve({
				stdout: typeof stdout === "string" ? stdout : "",
				stderr: typeof stderr === "string" ? stderr : "",
			});
		});
	});
}
