import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketplaceResourceProvider } from "../marketplace-resource";

describe("vercel.MarketplaceResourceProvider", () => {
	let mockFetch: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockFetch = vi.fn();
		vi.stubGlobal("fetch", mockFetch);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("provisions a store via the integration/direct endpoint and exposes externalResourceId", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					store: {
						id: "store_1",
						externalResourceId: "res_1",
						status: "available",
					},
				}),
		});

		const provider = new MarketplaceResourceProvider();

		const result = await provider.create({
			token: "tok",
			teamId: "team_xyz",
			integrationConfigurationId: "icfg_abc",
			name: "rby-humanes-kv",
			type: "upstash-kv",
			externalId: "rby-humanes-kv",
		});

		const [url, init] = mockFetch.mock.calls[0];
		expect(url).toContain("/v1/storage/stores/integration/direct");
		expect(init.method).toBe("POST");
		const body = JSON.parse(init.body);

		expect(body).toMatchObject({
			name: "rby-humanes-kv",
			integrationConfigurationId: "icfg_abc",
			integrationProductIdOrSlug: "upstash-kv",
			externalId: "rby-humanes-kv",
		});

		expect(result.id).toBe("store_1");
		expect(result.outs.externalResourceId).toBe("res_1");
	});

	it("throws on a non-ok response", async () => {
		mockFetch.mockResolvedValue({
			ok: false,
			status: 402,
			text: () => Promise.resolve("payment required"),
		});

		const provider = new MarketplaceResourceProvider();

		await expect(
			provider.create({
				token: "tok",
				teamId: "team_xyz",
				integrationConfigurationId: "icfg_abc",
				name: "n",
				type: "upstash-kv",
				externalId: "n",
			}),
		).rejects.toThrow(/402/);
	});

	const olds = {
		token: "tok",
		teamId: "team_xyz",
		integrationConfigurationId: "icfg_abc",
		name: "rby-humanes-kv",
		type: "upstash-kv",
		externalId: "rby-humanes-kv",
		metadata: { plan: "free" },
		storeId: "store_1",
		externalResourceId: "res_1",
		status: "available",
	};

	describe("update", () => {
		it("PATCHes metadata to the Update Resource endpoint", async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ name: "rby-humanes-kv" }),
			});

			const provider = new MarketplaceResourceProvider();

			const result = await provider.update("store_1", olds, {
				...olds,
				metadata: { plan: "pro" },
			});

			const [url, init] = mockFetch.mock.calls[0];
			expect(url).toContain("/v1/installations/icfg_abc/resources/store_1");
			expect(init.method).toBe("PATCH");
			expect(JSON.parse(init.body)).toEqual({ metadata: { plan: "pro" } });

			expect(result.outs.metadata).toEqual({ plan: "pro" });
			expect(result.outs.storeId).toBe("store_1");
			// Fields untouched by this update are preserved from prior state.
			expect(result.outs.externalResourceId).toBe("res_1");
		});
	});

	describe("diff", () => {
		it("flags a metadata change as an in-place update, not a replace", async () => {
			const provider = new MarketplaceResourceProvider();

			const diff = await provider.diff("store_1", olds, {
				...olds,
				metadata: { plan: "pro" },
			});

			expect(diff.changes).toBe(true);
			expect(diff.replaces).toEqual([]);
		});

		it("flags a name change as a replace", async () => {
			const provider = new MarketplaceResourceProvider();

			const diff = await provider.diff("store_1", olds, {
				...olds,
				name: "renamed",
			});

			expect(diff.changes).toBe(true);
			expect(diff.replaces).toEqual(["name"]);
		});

		it("reports no changes when nothing differs", async () => {
			const provider = new MarketplaceResourceProvider();

			const diff = await provider.diff("store_1", olds, olds);

			expect(diff.changes).toBe(false);
			expect(diff.replaces).toEqual([]);
		});

		it("ignores billingPlanId changes (create-time-only; the Update Resource endpoint needs a full billingPlan object this provider doesn't have)", async () => {
			const provider = new MarketplaceResourceProvider();

			const diff = await provider.diff("store_1", olds, {
				...olds,
				billingPlanId: "plan_pro",
			});

			expect(diff.changes).toBe(false);
		});
	});
});
