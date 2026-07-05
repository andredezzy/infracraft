import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VercelResourceConnectionProvider } from "../resource-connection";

describe("VercelResourceConnectionProvider", () => {
	let mockFetch: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockFetch = vi.fn();
		vi.stubGlobal("fetch", mockFetch);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	describe("create", () => {
		it("POSTs to the store connections endpoint with the right body when no connection exists", async () => {
			// First call: list connections (none). Second call: create connection.
			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ connections: [] }),
				})
				.mockResolvedValueOnce({
					ok: true,
					status: 201,
					json: () => Promise.resolve({}),
				});

			const provider = new VercelResourceConnectionProvider();

			const result = await provider.create({
				token: "tok",
				teamId: "team_xyz",
				storeId: "store_abc",
				projectId: "prj_humanes",
				targets: ["production", "preview"],
				makeEnvVarsSensitive: true,
			});

			const [listUrl] = mockFetch.mock.calls[0];

			expect(listUrl).toContain(
				"/v1/storage/stores/store_abc/connections?teamId=team_xyz",
			);

			const [postUrl, init] = mockFetch.mock.calls[1];
			expect(postUrl).toContain("/v1/storage/stores/store_abc/connections");
			expect(init.method).toBe("POST");

			expect(JSON.parse(init.body)).toEqual({
				projectId: "prj_humanes",
				envVarEnvironments: ["production", "preview"],
				makeEnvVarsSensitive: true,
			});

			expect(result.id).toBe("store_abc:prj_humanes");
		});

		it("adopts an existing connection without POSTing", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						connections: [{ id: "conn_1", projectId: "prj_humanes" }],
					}),
			});

			const provider = new VercelResourceConnectionProvider();

			const result = await provider.create({
				token: "tok",
				teamId: "team_xyz",
				storeId: "store_abc",
				projectId: "prj_humanes",
				targets: ["production", "preview"],
				makeEnvVarsSensitive: true,
			});

			// Only the list call happened — no POST.
			expect(mockFetch).toHaveBeenCalledTimes(1);
			expect(result.id).toBe("store_abc:prj_humanes");
		});

		it("rejects sensitive env vars combined with the development target", async () => {
			const provider = new VercelResourceConnectionProvider();

			await expect(
				provider.create({
					token: "tok",
					teamId: "team_xyz",
					storeId: "store_abc",
					projectId: "prj_humanes",
					targets: ["production", "development"],
					makeEnvVarsSensitive: true,
				}),
			).rejects.toThrow(/development/);

			expect(mockFetch).not.toHaveBeenCalled();
		});

		it("throws on a non-ok create response", async () => {
			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ connections: [] }),
				})
				.mockResolvedValueOnce({
					ok: false,
					status: 403,
					text: () => Promise.resolve("forbidden"),
				});

			const provider = new VercelResourceConnectionProvider();

			await expect(
				provider.create({
					token: "tok",
					teamId: "team_xyz",
					storeId: "store_abc",
					projectId: "prj_humanes",
					targets: ["production"],
					makeEnvVarsSensitive: true,
				}),
			).rejects.toThrow(/403/);
		});
	});
});
