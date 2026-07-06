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

	describe("check", () => {
		const inputs = {
			token: "tok",
			teamId: "team_xyz",
			storeId: "store_abc",
			projectId: "prj_humanes",
			targets: ["production", "development"],
			makeEnvVarsSensitive: true,
		};

		it("rejects sensitive env vars combined with the development target at plan time", async () => {
			const result = await new VercelResourceConnectionProvider().check(
				inputs,
				inputs,
			);

			expect(result.failures).toHaveLength(1);
			expect(result.failures?.[0].property).toBe("targets");
			expect(result.failures?.[0].reason).toContain("development");
			expect(mockFetch).not.toHaveBeenCalled();
		});

		it("passes when development is combined with non-sensitive env vars", async () => {
			const result = await new VercelResourceConnectionProvider().check(
				inputs,
				{ ...inputs, makeEnvVarsSensitive: false },
			);

			expect(result.failures).toEqual([]);
		});

		it("passes when sensitive env vars target an environment other than development", async () => {
			const result = await new VercelResourceConnectionProvider().check(
				inputs,
				{ ...inputs, targets: ["production", "preview"] },
			);

			expect(result.failures).toEqual([]);
		});
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

	describe("read", () => {
		const props = {
			token: "tok",
			teamId: "team_xyz",
			storeId: "store_abc",
			projectId: "prj_humanes",
			targets: ["production", "preview"],
			makeEnvVarsSensitive: true,
		};

		it("keeps the stored state when the connection still exists", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						connections: [{ id: "conn_1", projectId: "prj_humanes" }],
					}),
			});

			const provider = new VercelResourceConnectionProvider();

			const result = await provider.read("store_abc:prj_humanes", props);

			expect(result).toEqual({ id: "store_abc:prj_humanes", props });
		});

		it("returns blank state when no connection to this project exists (disconnected out-of-band)", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ connections: [] }),
			});

			const provider = new VercelResourceConnectionProvider();

			const result = await provider.read("store_abc:prj_humanes", props);

			expect(result).toEqual({});
		});

		it("returns blank state when the store itself is gone (404)", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 404,
				text: () => Promise.resolve("not found"),
			});

			const provider = new VercelResourceConnectionProvider();

			const result = await provider.read("store_abc:prj_humanes", props);

			expect(result).toEqual({});
		});
	});
});
