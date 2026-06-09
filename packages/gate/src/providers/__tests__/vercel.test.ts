import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Provider } from "../provider";
import { vercelProvider } from "../vercel";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-vercel-"));
	process.env.GATE_VERCEL_AUTH_FILE = path.join(dir, "auth.json");
});

afterEach(() => {
	delete process.env.GATE_VERCEL_AUTH_FILE;
	vi.restoreAllMocks();
});

describe("vercelProvider identity card", () => {
	it("declares the contract surface", () => {
		expect(vercelProvider.id).toBe(Provider.VERCEL);
		expect(vercelProvider.binary).toBe("vercel");
		expect(vercelProvider.layout).toEqual({
			authMount: [],
			deployVerb: "deploy",
		});
		expect(vercelProvider.loginArgv).toEqual(["vercel", "login"]);
		expect(vercelProvider.refresh).toBeDefined();
	});
});

describe("native session round-trip", () => {
	it("reads null when no auth file exists", () => {
		expect(vercelProvider.readNativeSession()).toBeNull();
	});

	it("reads token/refreshToken/expiresAt", () => {
		fs.writeFileSync(
			process.env.GATE_VERCEL_AUTH_FILE as string,
			JSON.stringify({
				token: "t",
				refreshToken: "r",
				expiresAt: 5,
				other: true,
			}),
		);

		expect(vercelProvider.readNativeSession()).toEqual({
			token: "t",
			refreshToken: "r",
			expiresAt: 5,
		});
	});

	it("writeNativeSession merges over unrelated keys", () => {
		const file = process.env.GATE_VERCEL_AUTH_FILE as string;
		fs.writeFileSync(
			file,
			JSON.stringify({ token: "old", skippedTeamSelection: true }),
		);

		vercelProvider.writeNativeSession({
			token: "new",
			refreshToken: "r2",
			expiresAt: 9,
		});

		const written = JSON.parse(fs.readFileSync(file, "utf-8"));
		expect(written).toEqual({
			token: "new",
			refreshToken: "r2",
			expiresAt: 9,
			skippedTeamSelection: true,
		});
	});
});

describe("API calls", () => {
	it("validate hits /v2/user with the bearer token", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));

		expect(await vercelProvider.validate("tok")).toBe(true);

		expect(fetchMock).toHaveBeenCalledWith("https://api.vercel.com/v2/user", {
			headers: { Authorization: "Bearer tok" },
		});
	});

	it("validate is false on 403 and on network error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("{}", { status: 403 }),
		);
		expect(await vercelProvider.validate("tok")).toBe(false);

		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
		expect(await vercelProvider.validate("tok")).toBe(false);
	});

	it("identity returns the username", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ user: { username: "andre" } }), {
				status: 200,
			}),
		);

		expect(await vercelProvider.identity("tok")).toBe("andre");
	});

	it("refresh exchanges the refresh token at the discovered endpoint", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ token_endpoint: "https://vercel.com/oauth/token" }),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						access_token: "new",
						refresh_token: "new-r",
						expires_in: 3600,
					}),
					{ status: 200 },
				),
			);

		const refreshed = await vercelProvider.refresh?.({
			token: "old",
			refreshToken: "old-r",
		});

		expect(refreshed?.token).toBe("new");
		expect(refreshed?.refreshToken).toBe("new-r");
		expect(refreshed?.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

		const body = fetchMock.mock.calls[1]?.[1]?.body as URLSearchParams;
		expect(body.get("grant_type")).toBe("refresh_token");
		expect(body.get("refresh_token")).toBe("old-r");
	});

	it("refresh returns null without a refresh token or on a failed exchange", async () => {
		expect(await vercelProvider.refresh?.({ token: "t" })).toBeNull();

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("{}", { status: 400 }),
		);
		expect(
			await vercelProvider.refresh?.({ token: "t", refreshToken: "r" }),
		).toBeNull();
	});
});

describe("deployCli", () => {
	it("injects --token and forwards passthrough args", () => {
		const command = vercelProvider.deployCli({
			token: "tok",
			passthroughArgs: ["--prod", "--force"],
		});

		expect(command.argv).toEqual([
			"vercel",
			"deploy",
			"--token",
			"tok",
			"--yes",
			"--prod",
			"--force",
		]);
		expect(command.env).toEqual({});
	});
});
