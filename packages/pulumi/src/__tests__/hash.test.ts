import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashDirectory } from "../hash";

describe("hashDirectory", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hash-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("produces a deterministic 64-char hex hash", () => {
		fs.writeFileSync(path.join(tmpDir, "file.ts"), "content");

		const hash1 = hashDirectory(tmpDir);
		const hash2 = hashDirectory(tmpDir);

		expect(hash1).toBe(hash2);
		expect(hash1).toHaveLength(64);
	});

	it("produces different hashes for different content", () => {
		fs.writeFileSync(path.join(tmpDir, "file.ts"), "content-a");
		const hash1 = hashDirectory(tmpDir);

		fs.writeFileSync(path.join(tmpDir, "file.ts"), "content-b");
		const hash2 = hashDirectory(tmpDir);

		expect(hash1).not.toBe(hash2);
	});

	it("ignores node_modules and dist by default", () => {
		fs.writeFileSync(path.join(tmpDir, "file.ts"), "content");
		const hash1 = hashDirectory(tmpDir);

		fs.mkdirSync(path.join(tmpDir, "node_modules"));
		fs.writeFileSync(path.join(tmpDir, "node_modules", "pkg.js"), "module");
		fs.mkdirSync(path.join(tmpDir, "dist"));
		fs.writeFileSync(path.join(tmpDir, "dist", "out.js"), "built");

		const hash2 = hashDirectory(tmpDir);

		expect(hash1).toBe(hash2);
	});

	it("accepts a custom ignore set", () => {
		fs.writeFileSync(path.join(tmpDir, "file.ts"), "content");
		fs.mkdirSync(path.join(tmpDir, "__tests__"));
		fs.writeFileSync(path.join(tmpDir, "__tests__", "test.ts"), "test");

		const withTests = hashDirectory(tmpDir);

		const withoutTests = hashDirectory(tmpDir, {
			ignore: new Set(["__tests__"]),
		});

		expect(withTests).not.toBe(withoutTests);
	});
});
