import { describe, expect, it } from "vitest";
import { buildSandboxFileFilter } from "../sandbox";

describe("buildSandboxFileFilter", () => {
	it("is a passthrough when nothing is excluded", () => {
		expect(buildSandboxFileFilter()).toBe("cat");
		expect(buildSandboxFileFilter([])).toBe("cat");
	});

	it("drops a non-apps path and its subtree", () => {
		const filter = buildSandboxFileFilter(["docs"]);
		expect(filter).toContain("awk");
		expect(filter).toContain("!/^docs(\\/|$)/");
	});

	it("drops an app's code but keeps its package.json", () => {
		const filter = buildSandboxFileFilter(["apps/mesh"]);
		expect(filter).toContain("/^apps\\/mesh\\//");
		expect(filter).toContain("!/^apps\\/mesh\\/package\\.json$/");
	});

	it("ANDs every exclude clause into one awk program", () => {
		const filter = buildSandboxFileFilter(["apps/mesh", "docs"]);
		expect(filter.match(/&&/g)?.length).toBeGreaterThanOrEqual(1);
		expect(filter).toContain("apps\\/mesh");
		expect(filter).toContain("docs");
	});
});
