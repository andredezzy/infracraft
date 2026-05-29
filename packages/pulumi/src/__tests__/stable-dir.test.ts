import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { stableDir } from "../stable-dir";

describe("stableDir", () => {
	it("returns '.' when the path is the program working directory", () => {
		expect(stableDir(process.cwd())).toBe(".");
	});

	it("returns a parent-relative path for an ancestor directory", () => {
		expect(stableDir(path.resolve(process.cwd(), ".."))).toBe("..");
	});

	it("returns a descendant-relative path for a nested directory", () => {
		const nested = path.join(process.cwd(), "apps", "api");

		expect(stableDir(nested)).toBe(path.join("apps", "api"));
	});

	it("yields an identical value for the same layout under different roots", () => {
		const programDir = process.cwd();

		const rootA = path.resolve(programDir, "..");
		const rootB = path.resolve("/somewhere/else/repo");

		// Both program dirs sit one level below their monorepo root, so the
		// stored `dir` is `..` in both checkouts — independent of the absolute
		// prefix. This is the property that stops cross-machine replacement.
		expect(stableDir(rootA)).toBe("..");
		expect(path.relative(path.join(rootB, "infrastructure"), rootB)).toBe("..");
	});
});
