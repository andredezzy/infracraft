import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VercelIntegrationResourceProvider } from "../integration";

describe("VercelIntegrationResourceProvider", () => {
	let mockFetch: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockFetch = vi.fn();
		vi.stubGlobal("fetch", mockFetch);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	describe("create", () => {
		it("resolves an installed integration slug to its configuration id (top-level array response, view=account)", async () => {
			// The real endpoint returns a top-level array.
			mockFetch.mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve([
						{ id: "icfg_upstash123", slug: "upstash" },
						{ id: "icfg_other", slug: "other" },
					]),
			});

			const provider = new VercelIntegrationResourceProvider();

			const result = await provider.create({
				token: "tok",
				teamId: "team_xyz",
				slug: "upstash",
			});

			expect(fetch).toHaveBeenCalledWith(
				expect.stringContaining("/v1/integrations/configurations?view=account"),
				expect.objectContaining({
					headers: expect.objectContaining({ Authorization: "Bearer tok" }),
				}),
			);

			expect(result.id).toBe("icfg_upstash123");
			expect(result.outs.configurationId).toBe("icfg_upstash123");
		});

		it("also accepts the { configurations: [...] } wrapped shape", async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						configurations: [{ id: "icfg_wrapped", slug: "upstash" }],
					}),
			});

			const provider = new VercelIntegrationResourceProvider();

			const result = await provider.create({
				token: "tok",
				teamId: "team_xyz",
				slug: "upstash",
			});

			expect(result.outs.configurationId).toBe("icfg_wrapped");
		});

		it("throws (naming the slug) when the integration is not installed on the team", async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve([]),
			});

			const provider = new VercelIntegrationResourceProvider();

			await expect(
				provider.create({ token: "tok", teamId: "team_xyz", slug: "upstash" }),
			).rejects.toThrow(
				'Vercel integration "upstash" is not installed on this team',
			);
		});
	});
});
