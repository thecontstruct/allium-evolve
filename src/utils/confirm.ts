import { createInterface } from "node:readline";

export async function confirmContinue(message: string): Promise<boolean> {
	if (!process.stdin.isTTY) {
		throw new Error(
			"Non-interactive terminal detected — cannot prompt for confirmation. Use --yes to skip confirmation.",
		);
	}
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	return new Promise((resolve) => {
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.trim().toLowerCase() === "y");
		});
	});
}
