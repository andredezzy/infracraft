import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	pickProductionDomain,
	VercelProjectResourceProvider,
} from "../project";

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

describe("VercelProjectResourceProvider", () => {
	let mockFetch: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockFetch = vi.fn();
		vi.stubGlobal("fetch", mockFetch);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const props = () => ({
		token: "tok",
		teamId: "team_1",
		name: "rby-feature-nexus",
		projectId: "prj_1",
	});

	describe("check", () => {
		// Rule per Vercel docs (Project configuration → General settings): up to
		// 100 chars, lowercase letters/digits/"."/"_"/"-", no "---" sequence.
		const inputs = (name: string) => ({ token: "tok", teamId: "team_1", name });

		it("passes a valid project name through untouched", async () => {
			const valid = inputs("rby-nexus_2.0");

			const result = await new VercelProjectResourceProvider().check(
				valid,
				valid,
			);

			expect(result.inputs).toEqual(valid);
			expect(result.failures).toEqual([]);
		});

		it("fails an uppercase name, naming the property", async () => {
			const invalid = inputs("Rby-Nexus");

			const result = await new VercelProjectResourceProvider().check(
				invalid,
				invalid,
			);

			expect(result.failures).toHaveLength(1);
			expect(result.failures?.[0].property).toBe("name");
			expect(result.failures?.[0].reason).toContain("lowercase");
		});

		it('fails a name containing the "---" sequence', async () => {
			const invalid = inputs("rby---nexus");

			const result = await new VercelProjectResourceProvider().check(
				invalid,
				invalid,
			);

			expect(result.failures).toHaveLength(1);
			expect(result.failures?.[0].property).toBe("name");
		});

		it("fails a name longer than 100 characters", async () => {
			const invalid = inputs("a".repeat(101));

			const result = await new VercelProjectResourceProvider().check(
				invalid,
				invalid,
			);

			expect(result.failures).toHaveLength(1);
			expect(result.failures?.[0].property).toBe("name");
		});
	});

	describe("read", () => {
		it("returns a blank ReadResult when the project is gone (deleted out of band)", async () => {
			mockFetch.mockResolvedValue({ ok: false, status: 404 });

			const result = await new VercelProjectResourceProvider().read(
				"prj_1",
				props(),
			);

			expect(result).toEqual({});
		});

		it("refreshes props when the project still exists", async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				status: 200,
				json: () => Promise.resolve({ id: "prj_1", name: "renamed-nexus" }),
			});

			const result = await new VercelProjectResourceProvider().read(
				"prj_1",
				props(),
			);

			expect(result.id).toBe("prj_1");
			expect(result.props?.name).toBe("renamed-nexus");
		});
	});

	describe("delete", () => {
		it("deletes the project via the projects API", async () => {
			mockFetch.mockResolvedValue({ ok: true, status: 204 });

			await new VercelProjectResourceProvider().delete("prj_1", props());

			const [url, init] = mockFetch.mock.calls[0];
			expect(url).toContain("/v9/projects/prj_1");
			expect(init.method).toBe("DELETE");
		});

		it("tolerates a 404 (already gone)", async () => {
			mockFetch.mockResolvedValue({ ok: false, status: 404 });

			await expect(
				new VercelProjectResourceProvider().delete("prj_1", props()),
			).resolves.toBeUndefined();
		});
	});
});
