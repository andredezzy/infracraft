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

	describe("path collections", () => {
		let root: string;

		const write = (rel: string, body: string) => {
			const full = path.join(root, rel);
			fs.mkdirSync(path.dirname(full), { recursive: true });
			fs.writeFileSync(full, body);
		};

		beforeEach(() => {
			root = fs.mkdtempSync(path.join(os.tmpdir(), "hash-paths-"));
			write("a/one.ts", "one");
			write("b/two.ts", "two");
		});

		afterEach(() => {
			fs.rmSync(root, { recursive: true, force: true });
		});

		it("is deterministic across calls", () => {
			const dirs = [path.join(root, "a"), path.join(root, "b")];

			expect(hash(dirs, { base: root })).toBe(hash(dirs, { base: root }));
		});

		it("treats caller order as semantic", () => {
			const forward = hash([path.join(root, "a"), path.join(root, "b")], {
				base: root,
			});

			const reversed = hash([path.join(root, "b"), path.join(root, "a")], {
				base: root,
			});

			expect(forward).not.toBe(reversed);
		});

		it("labels entries relative to base, so moving content between entries changes the digest", () => {
			const dirs = [path.join(root, "a"), path.join(root, "b")];
			const before = hash(dirs, { base: root });

			// Same bytes, different owning entry.
			fs.rmSync(path.join(root, "a", "one.ts"));
			write("b/one.ts", "one");
			fs.rmSync(path.join(root, "b", "two.ts"));
			write("a/two.ts", "two");

			expect(hash(dirs, { base: root })).not.toBe(before);
		});

		it("digest never contains the absolute base prefix", () => {
			const copy = fs.mkdtempSync(path.join(os.tmpdir(), "hash-paths-copy-"));
			fs.cpSync(root, copy, { recursive: true });

			const original = hash([path.join(root, "a")], { base: root });
			const relocated = hash([path.join(copy, "a")], { base: copy });

			fs.rmSync(copy, { recursive: true, force: true });

			expect(original).toBe(relocated);
		});

		it("accepts single-file entries", () => {
			const file = path.join(root, "a", "one.ts");
			const labeled = hash([file], { base: root });

			expect(labeled).toHaveLength(64);
			expect(labeled).toBe(hash([file], { base: root }));

			write("a/one.ts", "changed");

			expect(hash([file], { base: root })).not.toBe(labeled);
		});

		it("throws on a missing path instead of silently hashing nothing", () => {
			expect(() => hash(path.join(root, "missing"))).toThrow();
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
