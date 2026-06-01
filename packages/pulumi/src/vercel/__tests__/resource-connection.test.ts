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

	it("POSTs to the installations/{icfg}/resources/{resourceId}/connections endpoint with the right body", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			status: 201,
			text: () => Promise.resolve(""),
		});

		const provider = new VercelResourceConnectionProvider();

		await provider.create({
			token: "tok",
			teamId: "team_xyz",
			integrationConfigurationId: "icfg_abc",
			resourceId: "res_1",
			projectId: "prj_humanes",
			targets: ["production", "preview", "development"],
		});

		const [url, init] = mockFetch.mock.calls[0];

		expect(url).toContain(
			"/v1/integrations/installations/icfg_abc/resources/res_1/connections",
		);

		expect(init.method).toBe("POST");

		expect(JSON.parse(init.body)).toEqual({
			projectId: "prj_humanes",
			envVarEnvironments: ["production", "preview", "development"],
			makeEnvVarsSensitive: true,
		});
	});

	it("throws on a non-ok response", async () => {
		mockFetch.mockResolvedValue({
			ok: false,
			status: 403,
			text: () => Promise.resolve("forbidden"),
		});

		const provider = new VercelResourceConnectionProvider();

		await expect(
			provider.create({
				token: "tok",
				teamId: "team_xyz",
				integrationConfigurationId: "icfg_abc",
				resourceId: "res_1",
				projectId: "prj_humanes",
				targets: ["production"],
			}),
		).rejects.toThrow(/403/);
	});
});
