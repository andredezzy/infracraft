import { afterEach, describe, expect, it, vi } from "vitest";

import { RailwayClient } from "../client";

describe("RailwayClient", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("sends GraphQL query with auth header and returns data", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ data: { me: { id: "user-1" } } }),
		});

		const client = new RailwayClient("test-token");
		const result = await client.query<{ me: { id: string } }>("{ me { id } }");

		expect(result.me.id).toBe("user-1");

		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[1].headers.Authorization).toBe("Bearer test-token");
	});

	it("throws on GraphQL errors", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					errors: [{ message: "Project not found" }],
				}),
		});

		const client = new RailwayClient("test-token");

		await expect(client.query("{ project }")).rejects.toThrow(
			"Project not found",
		);
	});

	it("throws on non-200 HTTP status", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 401,
			statusText: "Unauthorized",
		});

		const client = new RailwayClient("test-token");

		await expect(client.query("{ me }")).rejects.toThrow("401");
	});
});
