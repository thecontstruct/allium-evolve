import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		env: {
			NODE_ENV: "test",
		},
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts", "src/cli.ts"],
		},
	},
});
