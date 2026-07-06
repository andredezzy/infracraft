import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationResourceProvider } from "../integration";

describe("vercel.IntegrationResourceProvider", () => {
	let mockFetch: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockFetch = vi.fn();
		vi.stubGlobal("fetch", mockFetch);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	describe("provider credentials", () => {
		it("resolves the API token from the env var named by tokenEnvVar", async () => {
			vi.stubEnv("INFRACRAFT_TEST_VERCEL_TOKEN", "env-tok");

			mockFetch.mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve([{ id: "icfg_upstash123", slug: "upstash" }]),
			});

			const provider = new IntegrationResourceProvider();

			await provider.create({
				tokenEnvVar: "INFRACRAFT_TEST_VERCEL_TOKEN",
				teamId: "team_xyz",
				slug: "upstash",
			});

			expect(fetch).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					headers: expect.objectContaining({
						Authorization: "Bearer env-tok",
					}),
				}),
			);
		});

		it("throws a loud error naming the env var when it is not set", async () => {
			const provider = new IntegrationResourceProvider();

			await expect(
				provider.create({
					tokenEnvVar: "INFRACRAFT_TEST_VERCEL_TOKEN_UNSET",
					teamId: "team_xyz",
					slug: "upstash",
				}),
			).rejects.toThrow(
				"provider credential env var INFRACRAFT_TEST_VERCEL_TOKEN_UNSET is not set in the Pulumi execution environment",
			);
		});
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

			const provider = new IntegrationResourceProvider();

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

			const provider = new IntegrationResourceProvider();

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

			const provider = new IntegrationResourceProvider();

			await expect(
				provider.create({ token: "tok", teamId: "team_xyz", slug: "upstash" }),
			).rejects.toThrow(
				'vercel.Integration "upstash" is not installed on this team',
			);
		});
	});
});
