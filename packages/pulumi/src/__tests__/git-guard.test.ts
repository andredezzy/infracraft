import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureGitignore, GUARD_DIR } from "../git-guard";

describe("ensureGitignore", () => {
	let tmpDir: string;
	let gitignorePath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitguard-test-"));
		gitignorePath = path.join(tmpDir, ".gitignore");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates .gitignore with guard dir if file does not exist", () => {
		ensureGitignore(gitignorePath);

		const content = fs.readFileSync(gitignorePath, "utf-8");
		expect(content).toContain(GUARD_DIR);
	});

	it("appends guard dir to existing .gitignore", () => {
		fs.writeFileSync(gitignorePath, "node_modules\ndist\n");

		ensureGitignore(gitignorePath);

		const content = fs.readFileSync(gitignorePath, "utf-8");
		expect(content).toContain("node_modules");
		expect(content).toContain(GUARD_DIR);
	});

	it("does not duplicate guard dir if already present", () => {
		fs.writeFileSync(gitignorePath, `node_modules\n${GUARD_DIR}\n`);

		ensureGitignore(gitignorePath);

		const content = fs.readFileSync(gitignorePath, "utf-8");
		const occurrences = content.split(GUARD_DIR).length - 1;
		expect(occurrences).toBe(1);
	});

	it("adds newline before guard dir when file lacks trailing newline", () => {
		fs.writeFileSync(gitignorePath, "node_modules");

		ensureGitignore(gitignorePath);

		const content = fs.readFileSync(gitignorePath, "utf-8");
		expect(content).toBe(`node_modules\n${GUARD_DIR}\n`);
	});
});
