import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as pulumi from "@pulumi/pulumi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hash, hashApp } from "../hash";

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

	describe("hashApp (app + transitive workspace deps)", () => {
		let root: string;

		const write = (rel: string, body: string) => {
			const full = path.join(root, rel);
			fs.mkdirSync(path.dirname(full), { recursive: true });
			fs.writeFileSync(full, body);
		};

		beforeEach(() => {
			root = fs.mkdtempSync(path.join(os.tmpdir(), "hashapp-"));
			// web -> @acme/ui -> @acme/core ; @acme/other is unrelated.
			write(
				"apps/web/package.json",
				'{"name":"@acme/web","dependencies":{"@acme/ui":"workspace:*"}}',
			);
			write("apps/web/index.ts", "export const web = 1;");
			write(
				"packages/ui/package.json",
				'{"name":"@acme/ui","dependencies":{"@acme/core":"workspace:*"}}',
			);
			write("packages/ui/ui.ts", "export const ui = 1;");
			write("packages/core/package.json", '{"name":"@acme/core"}');
			write("packages/core/core.ts", "export const core = 1;");
			write("packages/other/package.json", '{"name":"@acme/other"}');
			write("packages/other/other.ts", "export const other = 1;");
		});

		afterEach(() => {
			fs.rmSync(root, { recursive: true, force: true });
		});

		it("is deterministic", () => {
			expect(hashApp(root, "apps/web")).toBe(hashApp(root, "apps/web"));
		});

		it("retriggers when a TRANSITIVE dep (@acme/core via @acme/ui) changes", () => {
			const before = hashApp(root, "apps/web");
			write("packages/core/core.ts", "export const core = 2;");
			expect(hashApp(root, "apps/web")).not.toBe(before);
		});

		it("does NOT retrigger when an unrelated package (@acme/other) changes", () => {
			const before = hashApp(root, "apps/web");
			write("packages/other/other.ts", "export const other = 2;");
			expect(hashApp(root, "apps/web")).toBe(before);
		});

		it("retriggers when the app's own source changes", () => {
			const before = hashApp(root, "apps/web");
			write("apps/web/index.ts", "export const web = 2;");
			expect(hashApp(root, "apps/web")).not.toBe(before);
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
