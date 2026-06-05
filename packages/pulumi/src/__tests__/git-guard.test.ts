import { describe, expect, it, vi } from "vitest";
import { GitGuard, isGitGuard } from "../git-guard";

vi.mock("@pulumi/pulumi", () => ({
	ComponentResource: class {
		constructor(
			public type: string,
			public name: string,
		) {}
		registerOutputs(_outputs?: unknown): void {}
	},
}));

describe("GitGuard", () => {
	it("is recognised by isGitGuard (brand)", () => {
		const guard = new GitGuard("git-guard");
		expect(isGitGuard(guard)).toBe(true);
		expect(isGitGuard({})).toBe(false);
		expect(isGitGuard(null)).toBe(false);
	});
});
