import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as pulumi from "@pulumi/pulumi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hash } from "../hash";

function resolve(output: pulumi.Output<string>): Promise<string> {
	return new Promise((res) => {
		output.apply((value) => {
			res(value);

			return value;
		});
	});
}

describe("hash", () => {
	describe("directory input", () => {
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hash-test-"));
		});

		afterEach(() => {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		it("produces a deterministic 64-char hex hash", () => {
			fs.writeFileSync(path.join(tmpDir, "file.ts"), "content");

			const first = hash(tmpDir);
			const second = hash(tmpDir);

			expect(first).toBe(second);
			expect(first).toHaveLength(64);
		});

		it("produces different hashes for different content", () => {
			fs.writeFileSync(path.join(tmpDir, "file.ts"), "content-a");
			const before = hash(tmpDir);

			fs.writeFileSync(path.join(tmpDir, "file.ts"), "content-b");
			const after = hash(tmpDir);

			expect(before).not.toBe(after);
		});

		it("ignores node_modules and dist by default", () => {
			fs.writeFileSync(path.join(tmpDir, "file.ts"), "content");
			const clean = hash(tmpDir);

			fs.mkdirSync(path.join(tmpDir, "node_modules"));
			fs.writeFileSync(path.join(tmpDir, "node_modules", "pkg.js"), "module");
			fs.mkdirSync(path.join(tmpDir, "dist"));
			fs.writeFileSync(path.join(tmpDir, "dist", "out.js"), "built");

			expect(hash(tmpDir)).toBe(clean);
		});

		it("accepts a custom ignore set", () => {
			fs.writeFileSync(path.join(tmpDir, "file.ts"), "content");
			fs.mkdirSync(path.join(tmpDir, "__tests__"));
			fs.writeFileSync(path.join(tmpDir, "__tests__", "test.ts"), "test");

			const withTests = hash(tmpDir);
			const withoutTests = hash(tmpDir, { ignore: new Set(["__tests__"]) });

			expect(withTests).not.toBe(withoutTests);
		});
	});

	describe("env input", () => {
		it("produces a deterministic 64-char hex digest", async () => {
			const digest = await resolve(hash({ A: "1", B: "2" }));

			expect(digest).toBe(await resolve(hash({ A: "1", B: "2" })));
			expect(digest).toHaveLength(64);
		});

		it("is independent of key order", async () => {
			const ordered = await resolve(hash({ A: "1", B: "2" }));
			const reversed = await resolve(hash({ B: "2", A: "1" }));

			expect(ordered).toBe(reversed);
		});

		it("changes when any value changes", async () => {
			const before = await resolve(hash({ A: "1", B: "2" }));
			const after = await resolve(hash({ A: "1", B: "3" }));

			expect(before).not.toBe(after);
		});

		it("does not collide when a key/value boundary shifts", async () => {
			const joined = await resolve(hash({ AB: "C" }));
			const split = await resolve(hash({ A: "BC" }));

			expect(joined).not.toBe(split);
		});

		it("resolves secret Output inputs to the same digest as plain values", async () => {
			const withSecret = await resolve(hash({ A: pulumi.secret("1"), B: "2" }));
			const plain = await resolve(hash({ A: "1", B: "2" }));

			expect(withSecret).toBe(plain);
		});
	});
});
