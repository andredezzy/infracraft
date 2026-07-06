import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiNotFoundError } from "../../errors/api-not-found-error";
import { VercelClient } from "../client";

describe("VercelClient", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("sends GET request with auth header and appends teamId", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: () => Promise.resolve({ id: "prj_1" }),
		});

		const client = new VercelClient("test-token", "team_1");
		const result = await client.get<{ id: string }>("/v9/projects/my-app");

		expect(result.id).toBe("prj_1");

		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];

		expect(call[0]).toBe(
			"https://api.vercel.com/v9/projects/my-app?teamId=team_1",
		);

		expect(call[1].headers.Authorization).toBe("Bearer test-token");
	});

	it("appends teamId with & when the path already has a query string", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: () => Promise.resolve([]),
		});

		const client = new VercelClient("test-token", "team_1");
		await client.get("/v1/integrations/configurations?view=account");

		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];

		expect(call[0]).toBe(
			"https://api.vercel.com/v1/integrations/configurations?view=account&teamId=team_1",
		);
	});

	it("omits teamId when the client is not team-scoped", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: () => Promise.resolve({}),
		});

		const client = new VercelClient("test-token");
		await client.get("/v9/projects/my-app");

		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[0]).toBe("https://api.vercel.com/v9/projects/my-app");
	});

	it("sends POST request with body", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: () => Promise.resolve({ id: "prj_1" }),
		});

		const client = new VercelClient("test-token", "team_1");

		const result = await client.post<{ id: string }>("/v9/projects", {
			name: "my-app",
		});

		expect(result.id).toBe("prj_1");

		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[1].method).toBe("POST");
		expect(JSON.parse(call[1].body)).toEqual({ name: "my-app" });
	});

	it("sends PATCH request with body", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: () => Promise.resolve({ name: "my-app" }),
		});

		const client = new VercelClient("test-token", "team_1");

		const result = await client.patch<{ name: string }>(
			"/v1/installations/icfg_1/resources/res_1",
			{ metadata: { plan: "pro" } },
		);

		expect(result.name).toBe("my-app");

		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[1].method).toBe("PATCH");
		expect(JSON.parse(call[1].body)).toEqual({ metadata: { plan: "pro" } });
	});

	it("throws ApiNotFoundError on 404", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 404,
			text: () => Promise.resolve("Not found"),
		});

		const client = new VercelClient("test-token", "team_1");
		const error = await client.get("/v9/projects/missing").catch((e) => e);

		expect(error).toBeInstanceOf(ApiNotFoundError);
		expect(error.provider).toBe("vercel");
		expect(error.path).toBe("/v9/projects/missing");
	});

	it("tryGet returns null on 404", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 404,
			text: () => Promise.resolve("Not found"),
		});

		const client = new VercelClient("test-token", "team_1");

		await expect(client.tryGet("/v9/projects/missing")).resolves.toBeNull();
	});

	it("throws on any other non-2xx HTTP status", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 401,
			text: () => Promise.resolve("Unauthorized"),
		});

		const client = new VercelClient("test-token", "team_1");

		await expect(client.get("/v9/projects/my-app")).rejects.toThrow(
			"Vercel API error (401): Unauthorized",
		);
	});
});
