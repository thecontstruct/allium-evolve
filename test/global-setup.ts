import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const FIXTURE_REPO = resolve(import.meta.dirname, "fixtures/repo");

export default function setup() {
	if (!existsSync(resolve(FIXTURE_REPO, ".git"))) {
		execSync("bash test/fixtures/create-fixture-repo.sh", {
			cwd: resolve(import.meta.dirname, ".."),
			stdio: "pipe",
		});
	}
}
