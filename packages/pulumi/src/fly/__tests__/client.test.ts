import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiNotFoundError } from "../../errors/api-not-found-error";
import { FlyClient } from "../client";

describe("FlyClient", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("sends GET to the Machines API with a bearer token", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve(JSON.stringify({ name: "my-app" })),
		});

		const client = new FlyClient("test-token");
		const result = await client.get<{ name: string }>("/v1/apps/my-app");

		expect(result.name).toBe("my-app");

		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[0]).toBe("https://api.machines.dev/v1/apps/my-app");
		expect(call[1].headers.Authorization).toBe("Bearer test-token");
	});

	it("tryGet returns null on 404 and throws on other errors", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValueOnce({
				ok: false,
				status: 404,
				text: () => Promise.resolve("nope"),
			})
			.mockResolvedValueOnce({
				ok: false,
				status: 403,
				text: () => Promise.resolve("forbidden"),
			});

		const client = new FlyClient("test-token");

		await expect(client.tryGet("/v1/apps/missing")).resolves.toBeNull();
		await expect(client.tryGet("/v1/apps/broken")).rejects.toThrow("403");
	});

	it("get throws ApiNotFoundError on 404", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 404,
			text: () => Promise.resolve("nope"),
		});

		const client = new FlyClient("test-token");
		const error = await client.get("/v1/apps/missing").catch((e) => e);

		expect(error).toBeInstanceOf(ApiNotFoundError);
		expect(error.provider).toBe("fly");
		expect(error.path).toBe("/v1/apps/missing");
	});

	it("sends POST with a JSON body", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 201,
			text: () => Promise.resolve(JSON.stringify({ id: "z4k69" })),
		});

		const client = new FlyClient("test-token");

		const result = await client.post<{ id: string }>("/v1/apps", {
			app_name: "x",
			org_slug: "personal",
		});

		expect(result.id).toBe("z4k69");

		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[1].method).toBe("POST");

		expect(JSON.parse(call[1].body)).toEqual({
			app_name: "x",
			org_slug: "personal",
		});
	});

	it("sends PUT with a JSON body", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () => Promise.resolve(JSON.stringify({ needs_restart: false })),
		});

		const client = new FlyClient("test-token");

		const result = await client.put<{ needs_restart: boolean }>(
			"/v1/apps/x/volumes/vol_123/extend",
			{ size_gb: 20 },
		);

		expect(result.needs_restart).toBe(false);

		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[1].method).toBe("PUT");
		expect(JSON.parse(call[1].body)).toEqual({ size_gb: 20 });
	});

	it("returns undefined for empty bodies (202/204)", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 204,
			text: () => Promise.resolve(""),
		});

		const client = new FlyClient("test-token");

		await expect(
			client.delete("/v1/apps/x/certificates/h"),
		).resolves.toBeUndefined();
	});

	it("throws on non-2xx REST responses", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 422,
			text: () => Promise.resolve("Unprocessable"),
		});

		const client = new FlyClient("test-token");
		await expect(client.post("/v1/apps", {})).rejects.toThrow("422");
	});

	it("graphql posts to the GraphQL endpoint and unwraps data", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () =>
				Promise.resolve(JSON.stringify({ data: { app: { name: "a" } } })),
		});

		const client = new FlyClient("test-token");

		const data = await client.graphql<{ app: { name: string } }>(
			"query { app { name } }",
			{},
		);

		expect(data.app.name).toBe("a");

		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[0]).toBe("https://api.fly.io/graphql");
		expect(JSON.parse(call[1].body).query).toContain("app");
	});

	it("graphql throws when the response contains errors", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: () =>
				Promise.resolve(JSON.stringify({ errors: [{ message: "bad query" }] })),
		});

		const client = new FlyClient("test-token");
		await expect(client.graphql("query {}", {})).rejects.toThrow("bad query");
	});
});
