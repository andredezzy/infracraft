import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { atomicWriteFile, readTextFile } from "../auth-file";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-authfile-"));
});

describe("readTextFile", () => {
	it("returns null for a missing file", () => {
		expect(readTextFile(path.join(dir, "absent.json"))).toBeNull();
	});

	it("returns the content for an existing file", () => {
		const file = path.join(dir, "a.json");
		fs.writeFileSync(file, "{}");

		expect(readTextFile(file)).toBe("{}");
	});
});

describe("atomicWriteFile", () => {
	it("creates parent directories and writes with mode 0600", () => {
		const file = path.join(dir, "nested", "auth.json");

		atomicWriteFile(file, '{"token":"t"}');

		expect(fs.readFileSync(file, "utf-8")).toBe('{"token":"t"}');
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	});

	it("replaces existing content", () => {
		const file = path.join(dir, "auth.json");
		fs.writeFileSync(file, "old");

		atomicWriteFile(file, "new");

		expect(fs.readFileSync(file, "utf-8")).toBe("new");
	});

	it("leaves no temp files behind", () => {
		const file = path.join(dir, "auth.json");

		atomicWriteFile(file, "x");

		expect(fs.readdirSync(dir)).toEqual(["auth.json"]);
	});
});
