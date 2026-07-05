import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiNotFoundError } from "../../errors/api-not-found-error";
import { NeonClient } from "../client";

describe("NeonClient", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("sends GET request with auth header and returns parsed JSON", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ projects: [] }),
		});

		const client = new NeonClient("test-api-key");
		const result = await client.get<{ projects: unknown[] }>("/projects");

		expect(result.projects).toEqual([]);

		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[0]).toContain("/projects");
		expect(call[1].headers.Authorization).toBe("Bearer test-api-key");
	});

	it("sends POST request with body", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ project: { id: "proj-1" } }),
		});

		const client = new NeonClient("test-api-key");

		const result = await client.post<{ project: { id: string } }>("/projects", {
			project: { name: "test" },
		});

		expect(result.project.id).toBe("proj-1");

		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[1].method).toBe("POST");
		expect(JSON.parse(call[1].body)).toEqual({ project: { name: "test" } });
	});

	it("throws on non-200 HTTP status", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 401,
			statusText: "Unauthorized",
			text: () => Promise.resolve("Unauthorized"),
		});

		const client = new NeonClient("test-api-key");

		await expect(client.get("/projects/invalid")).rejects.toThrow("401");
	});

	it("throws ApiNotFoundError on 404", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 404,
			statusText: "Not Found",
			text: () => Promise.resolve("Not found"),
		});

		const client = new NeonClient("test-api-key");
		const error = await client.get("/projects/missing").catch((e) => e);

		expect(error).toBeInstanceOf(ApiNotFoundError);
		expect(error.provider).toBe("neon");
		expect(error.path).toBe("/projects/missing");
	});
});

describe("NeonClient 423 operation-lock waiting", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("waits out a project-operations lock and then succeeds", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("project already has running conflicting operations", {
					status: 423,
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ branch: { id: "br-1" } }), {
					status: 200,
				}),
			);

		vi.stubGlobal("fetch", fetchMock);

		const client = new NeonClient("key");

		const pending = client.get<{ branch: { id: string } }>(
			"/projects/p/branches/br-1",
		);

		await vi.advanceTimersByTimeAsync(5_000);

		await expect(pending).resolves.toEqual({ branch: { id: "br-1" } });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("fails loudly when the lock never clears", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response("project already has running conflicting operations", {
				status: 423,
			}),
		);

		vi.stubGlobal("fetch", fetchMock);

		const client = new NeonClient("key");

		const pending = client
			.get("/projects/p/branches/br-1")
			.catch((error: Error) => error);

		await vi.advanceTimersByTimeAsync(5_000 * 30);

		const error = await pending;
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("Neon API error (423)");
	});
});
