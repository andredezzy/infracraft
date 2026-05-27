import { afterEach, describe, expect, it, vi } from "vitest";

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
			status: 404,
			statusText: "Not Found",
			text: () => Promise.resolve("Not found"),
		});

		const client = new NeonClient("test-api-key");

		await expect(client.get("/projects/invalid")).rejects.toThrow("404");
	});
});
