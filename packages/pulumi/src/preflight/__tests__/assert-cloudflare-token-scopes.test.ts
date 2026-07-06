import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertCloudflareTokenScopes } from "../assert-cloudflare-token-scopes";

const { resilientFetchMock } = vi.hoisted(() => ({
	resilientFetchMock: vi.fn(),
}));

vi.mock("../../http/resilient-fetch", () => ({
	resilientFetch: resilientFetchMock,
}));

/** Builds a minimal `Response` stand-in for the verify endpoint. */
function response(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response;
}

/** The success envelope Cloudflare returns for a valid, active token. */
function activeEnvelope(): unknown {
	return {
		success: true,
		errors: [],
		messages: [{ code: 10000, message: "This API Token is valid and active" }],
		result: { id: "tok_123", status: "active" },
	};
}

describe("assertCloudflareTokenScopes", () => {
	beforeEach(() => {
		resilientFetchMock.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("passes for a valid, active token and sends the Bearer token to the verify endpoint", async () => {
		resilientFetchMock.mockResolvedValue(response(200, activeEnvelope()));

		await expect(
			assertCloudflareTokenScopes({ token: "cf-token" }),
		).resolves.toBeUndefined();

		const [url, init] = resilientFetchMock.mock.calls[0];

		expect(url).toBe("https://api.cloudflare.com/client/v4/user/tokens/verify");

		expect(init.headers.Authorization).toBe("Bearer cf-token");
	});

	it("throws for a disabled (non-active) token, naming the status", async () => {
		resilientFetchMock.mockResolvedValue(
			response(200, {
				success: true,
				errors: [],
				messages: [],
				result: { id: "tok_123", status: "disabled" },
			}),
		);

		await expect(
			assertCloudflareTokenScopes({ token: "cf-token" }),
		).rejects.toThrow(/not active[\s\S]*disabled/);
	});

	it("throws on a 401 rejection", async () => {
		resilientFetchMock.mockResolvedValue(
			response(401, { success: false, errors: [], messages: [] }),
		);

		await expect(
			assertCloudflareTokenScopes({ token: "bad-token" }),
		).rejects.toThrow(/HTTP 401/);
	});

	it("throws on an empty token without calling the API", async () => {
		await expect(assertCloudflareTokenScopes({ token: "   " })).rejects.toThrow(
			/empty/,
		);

		expect(resilientFetchMock).not.toHaveBeenCalled();
	});

	it("warns (does not throw) that requiredPermissionGroups cannot be verified from the token", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		resilientFetchMock.mockResolvedValue(response(200, activeEnvelope()));

		await assertCloudflareTokenScopes({
			token: "cf-token",
			requiredPermissionGroups: ["Zone Settings Write", "DNS Write"],
		});

		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0][0]).toContain("could NOT be verified");
	});
});
