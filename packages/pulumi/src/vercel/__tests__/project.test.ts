import { describe, expect, it } from "vitest";
import { pickProductionDomain } from "../project";

const verified = (name: string) => ({
	name,
	verified: true,
	redirect: null,
	gitBranch: null,
});

describe("pickProductionDomain", () => {
	it("prefers a custom domain over the *.vercel.app default", () => {
		expect(
			pickProductionDomain(
				[verified("rby-nexus.vercel.app"), verified("app.royalbinary.io")],
				"rby-nexus",
			),
		).toBe("https://app.royalbinary.io");
	});

	it("is order-independent — custom wins even when listed first", () => {
		expect(
			pickProductionDomain(
				[verified("live.royalbinary.io"), verified("rby-live.vercel.app")],
				"rby-live",
			),
		).toBe("https://live.royalbinary.io");
	});

	it("uses the *.vercel.app domain when no custom domain is attached", () => {
		expect(
			pickProductionDomain(
				[verified("rby-staging-nexus.vercel.app")],
				"rby-staging-nexus",
			),
		).toBe("https://rby-staging-nexus.vercel.app");
	});

	it("falls back to <name>.vercel.app when the domain list is empty", () => {
		expect(pickProductionDomain([], "rby-feature-nexus")).toBe(
			"https://rby-feature-nexus.vercel.app",
		);
	});

	it("ignores redirect, branch, and unverified domains", () => {
		expect(
			pickProductionDomain(
				[
					{
						name: "old.example.com",
						verified: true,
						redirect: "new.example.com",
						gitBranch: null,
					},
					{
						name: "preview.example.com",
						verified: true,
						redirect: null,
						gitBranch: "feat",
					},
					{
						name: "unverified.example.com",
						verified: false,
						redirect: null,
						gitBranch: null,
					},
					verified("real.example.com"),
				],
				"proj",
			),
		).toBe("https://real.example.com");
	});
});
