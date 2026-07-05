import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VercelDomainResourceProvider } from "../domain";

describe("VercelDomainResourceProvider", () => {
	let mockFetch: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockFetch = vi.fn();
		vi.stubGlobal("fetch", mockFetch);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const inputs = () => ({
		token: "tok",
		teamId: "team_1",
		projectId: "prj_1",
		name: "app.example.com",
	});

	const configResponse = (recommendedCNAME: unknown[]) => ({
		ok: true,
		status: 200,
		json: async () => ({ recommendedCNAME }),
	});

	describe("create", () => {
		it("adopts an existing domain attachment and fetches its cnameTarget", async () => {
			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => ({
						name: "app.example.com",
						projectId: "prj_1",
						verified: true,
					}),
				}) // GET domain: found
				.mockResolvedValueOnce(
					configResponse([{ rank: 1, value: "76.76.21.21.vercel-dns.com" }]),
				); // GET config

			const result = await new VercelDomainResourceProvider().create(inputs());

			expect(result.id).toBe("prj_1/app.example.com");
			expect(result.outs.verified).toBe(true);
			expect(result.outs.cnameTarget).toBe("76.76.21.21.vercel-dns.com");
			expect(mockFetch).toHaveBeenCalledTimes(2); // GET domain + GET config, no POST
			const [url, init] = mockFetch.mock.calls[0];
			expect(url).toContain("/v9/projects/prj_1/domains/app.example.com");
			expect(init.method ?? "GET").toBe("GET");
			const [configUrl] = mockFetch.mock.calls[1];
			expect(configUrl).toContain("/v6/domains/app.example.com/config");
		});

		it("attaches a new domain when not found (404) and fetches its cnameTarget", async () => {
			mockFetch
				.mockResolvedValueOnce({ ok: false, status: 404 }) // GET: not found
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => ({
						name: "app.example.com",
						projectId: "prj_1",
						verified: false,
					}),
				}) // POST: created
				.mockResolvedValueOnce(
					configResponse([{ rank: 1, value: "76.76.21.21.vercel-dns.com" }]),
				); // GET config

			const result = await new VercelDomainResourceProvider().create(inputs());

			expect(result.id).toBe("prj_1/app.example.com");
			expect(result.outs.verified).toBe(false);
			expect(result.outs.cnameTarget).toBe("76.76.21.21.vercel-dns.com");
			const [url, init] = mockFetch.mock.calls[1];
			expect(url).toContain("/v10/projects/prj_1/domains");
			expect(init.method).toBe("POST");
			expect(JSON.parse(init.body)).toEqual({ name: "app.example.com" });
		});

		it("picks the lowest-ranked (most preferred) recommendation when several are returned", async () => {
			mockFetch
				.mockResolvedValueOnce({ ok: false, status: 404 })
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => ({
						name: "app.example.com",
						projectId: "prj_1",
						verified: false,
					}),
				})
				.mockResolvedValueOnce(
					configResponse([
						{ rank: 2, value: "second-choice.vercel-dns.com" },
						{ rank: 1, value: "first-choice.vercel-dns.com" },
					]),
				);

			const result = await new VercelDomainResourceProvider().create(inputs());

			expect(result.outs.cnameTarget).toBe("first-choice.vercel-dns.com");
		});

		it("falls back to the static CNAME target when Vercel recommends nothing", async () => {
			mockFetch
				.mockResolvedValueOnce({ ok: false, status: 404 })
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => ({
						name: "app.example.com",
						projectId: "prj_1",
						verified: false,
					}),
				})
				.mockResolvedValueOnce(configResponse([]));

			const result = await new VercelDomainResourceProvider().create(inputs());

			expect(result.outs.cnameTarget).toBe("cname.vercel-dns.com");
		});

		it("throws on a non-404 error status", async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 500,
				text: async () => "internal error",
			});

			await expect(
				new VercelDomainResourceProvider().create(inputs()),
			).rejects.toThrow(/Vercel API error fetching domain/);
		});
	});

	describe("delete", () => {
		it("deletes the domain attachment", async () => {
			mockFetch.mockResolvedValue({ ok: true, status: 204 });

			await new VercelDomainResourceProvider().delete("prj_1/app.example.com", {
				...inputs(),
				verified: true,
				cnameTarget: "cname.vercel-dns.com",
			});

			const [url, init] = mockFetch.mock.calls[0];
			expect(url).toContain("/v9/projects/prj_1/domains/app.example.com");
			expect(init.method).toBe("DELETE");
		});

		it("tolerates a 404 (already gone)", async () => {
			mockFetch.mockResolvedValue({ ok: false, status: 404 });

			await expect(
				new VercelDomainResourceProvider().delete("prj_1/app.example.com", {
					...inputs(),
					verified: true,
					cnameTarget: "cname.vercel-dns.com",
				}),
			).resolves.toBeUndefined();
		});
	});

	describe("diff", () => {
		it("replaces on name, projectId, or teamId changes", async () => {
			const olds = {
				...inputs(),
				verified: true,
				cnameTarget: "cname.vercel-dns.com",
			};

			const result = await new VercelDomainResourceProvider().diff(
				"prj_1/app.example.com",
				olds,
				{ ...inputs(), name: "other.example.com" },
			);

			expect(result.replaces).toContain("name");
			expect(result.changes).toBe(true);
			expect(result.deleteBeforeReplace).toBe(true);
		});

		it("reports no changes when nothing differs", async () => {
			const olds = {
				...inputs(),
				verified: true,
				cnameTarget: "cname.vercel-dns.com",
			};

			const result = await new VercelDomainResourceProvider().diff(
				"prj_1/app.example.com",
				olds,
				inputs(),
			);

			expect(result.changes).toBe(false);
			expect(result.replaces).toEqual([]);
		});
	});
});
