import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VercelMarketplaceResourceProvider } from "../marketplace-resource";

describe("VercelMarketplaceResourceProvider", () => {
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

		const provider = new VercelMarketplaceResourceProvider();

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

		const provider = new VercelMarketplaceResourceProvider();

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
});
