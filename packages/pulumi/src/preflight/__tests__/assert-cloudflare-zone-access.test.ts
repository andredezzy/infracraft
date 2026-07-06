import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertCloudflareZoneAccess } from "../assert-cloudflare-zone-access";

const { resilientFetchMock } = vi.hoisted(() => ({
	resilientFetchMock: vi.fn(),
}));

vi.mock("../../http/resilient-fetch", () => ({
	resilientFetch: resilientFetchMock,
}));

/** Builds a minimal `Response` stand-in for the zone-read endpoint. */
function response(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response;
}

describe("assertCloudflareZoneAccess", () => {
	beforeEach(() => {
		resilientFetchMock.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("passes for a token that can read the zone, sending the Bearer token to the zone endpoint", async () => {
		resilientFetchMock.mockResolvedValue(
			response(200, { success: true, errors: [], messages: [], result: {} }),
		);

		await expect(
			assertCloudflareZoneAccess({ token: "cf-token", zoneId: "zone-123" }),
		).resolves.toBeUndefined();

		const [url, init] = resilientFetchMock.mock.calls[0];

		expect(url).toBe("https://api.cloudflare.com/client/v4/zones/zone-123");
		expect(init.headers.Authorization).toBe("Bearer cf-token");
	});

	it("throws on a 401, naming the status", async () => {
		resilientFetchMock.mockResolvedValue(
			response(401, { success: false, errors: [], messages: [] }),
		);

		await expect(
			assertCloudflareZoneAccess({ token: "bad-token", zoneId: "zone-123" }),
		).rejects.toThrow(/HTTP 401/);
	});

	it("throws on a 403, naming the status and the zone", async () => {
		resilientFetchMock.mockResolvedValue(
			response(403, { success: false, errors: [], messages: [] }),
		);

		await expect(
			assertCloudflareZoneAccess({ token: "cf-token", zoneId: "zone-123" }),
		).rejects.toThrow(/HTTP 403[\s\S]*zone-123/);
	});

	it("throws on a 404, naming the status and the zone", async () => {
		resilientFetchMock.mockResolvedValue(
			response(404, { success: false, errors: [], messages: [] }),
		);

		await expect(
			assertCloudflareZoneAccess({ token: "cf-token", zoneId: "zone-123" }),
		).rejects.toThrow(/HTTP 404[\s\S]*zone-123/);
	});

	it("throws on any other non-2xx status", async () => {
		resilientFetchMock.mockResolvedValue(
			response(500, { success: false, errors: [], messages: [] }),
		);

		await expect(
			assertCloudflareZoneAccess({ token: "cf-token", zoneId: "zone-123" }),
		).rejects.toThrow(/unexpected HTTP 500/);
	});

	it("throws on an empty token without calling the API", async () => {
		await expect(
			assertCloudflareZoneAccess({ token: "   ", zoneId: "zone-123" }),
		).rejects.toThrow(/empty/);

		expect(resilientFetchMock).not.toHaveBeenCalled();
	});
});
