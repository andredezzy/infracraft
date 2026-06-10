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

	it("writeNativeSession drops refreshToken when the new session has none", () => {
		const file = process.env.GATE_VERCEL_AUTH_FILE as string;

		fs.writeFileSync(
			file,
			JSON.stringify({
				token: "old",
				refreshToken: "old-r",
				skippedTeamSelection: true,
			}),
		);

		vercelProvider.writeNativeSession({ token: "new" });

		const written = JSON.parse(fs.readFileSync(file, "utf-8"));
		expect(written).not.toHaveProperty("refreshToken");
		expect(written.token).toBe("new");
		expect(written.skippedTeamSelection).toBe(true);
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

describe("nativeCli", () => {
	it("injects --token immediately after the binary", () => {
		const command = vercelProvider.nativeCli({
			token: "tok",
			args: ["env", "ls", "--json"],
		});

		expect(command.argv).toEqual([
			"vercel",
			"--token",
			"tok",
			"env",
			"ls",
			"--json",
		]);

		expect(command.env).toEqual({});
		expect(command.notice).toBeUndefined();
	});

	it("skips injection when the user supplies their own --token", () => {
		const command = vercelProvider.nativeCli({
			token: "tok",
			args: ["whoami", "--token", "user-tok"],
		});

		expect(command.argv).toEqual(["vercel", "whoami", "--token", "user-tok"]);
		expect(command.notice).toContain("--token");
	});

	it("ignores a --token that sits behind a -- separator", () => {
		const command = vercelProvider.nativeCli({
			token: "tok",
			args: ["dev", "--", "--token", "inner"],
		});

		expect(command.argv).toEqual([
			"vercel",
			"--token",
			"tok",
			"dev",
			"--",
			"--token",
			"inner",
		]);
	});

	it("declares deploy metadata and no reserved flags", () => {
		expect(vercelProvider.deployVerb).toBe("deploy");
		expect(vercelProvider.deployDefaultFlags).toEqual(["--yes"]);
		expect(vercelProvider.reservedNativeFlags).toEqual([]);
	});

	it("composes the deploy argv (regression vs deployCli, modulo --token position)", () => {
		const command = vercelProvider.nativeCli({
			token: "tok",
			args: [
				vercelProvider.deployVerb,
				...vercelProvider.deployDefaultFlags,
				"--prod",
			],
		});

		expect(command.argv).toEqual([
			"vercel",
			"--token",
			"tok",
			"deploy",
			"--yes",
			"--prod",
		]);
	});
});

describe("deployTarget", () => {
	it("declares the project noun", () => {
		expect(vercelProvider.deployTarget?.noun).toBe("project");
	});

	it("resolveName reads --project and --project= forms", () => {
		const target = vercelProvider.deployTarget;

		expect(target?.resolveName(["--prod", "--project", "hat-rec"])).toBe(
			"hat-rec",
		);

		expect(target?.resolveName(["--project=hat-rec", "--prod"])).toBe(
			"hat-rec",
		);
	});

	it("resolveName is undefined without --project", () => {
		expect(
			vercelProvider.deployTarget?.resolveName(["--prod"]),
		).toBeUndefined();
	});

	it("resolveName is undefined for a valueless --project", () => {
		const target = vercelProvider.deployTarget;

		expect(target?.resolveName(["--prod", "--project"])).toBeUndefined();
		expect(target?.resolveName(["--project="])).toBeUndefined();
	});

	it("resolveName defers to the native CLI when --scope is present", () => {
		const target = vercelProvider.deployTarget;

		expect(
			target?.resolveName(["--project", "x", "--scope", "team"]),
		).toBeUndefined();

		expect(
			target?.resolveName(["--scope=team", "--project", "x"]),
		).toBeUndefined();
	});

	it("exists hits /v9/projects/{name} with the bearer token", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));

		expect(await vercelProvider.deployTarget?.exists("tok", "hat-rec")).toBe(
			true,
		);

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.vercel.com/v9/projects/hat-rec",
			{ headers: { Authorization: "Bearer tok" } },
		);
	});

	it("exists URL-encodes the project name", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));

		await vercelProvider.deployTarget?.exists("tok", "my project");

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.vercel.com/v9/projects/my%20project",
			{ headers: { Authorization: "Bearer tok" } },
		);
	});

	it("exists is false on 404 and throws on other failures", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("{}", { status: 404 }),
		);

		expect(await vercelProvider.deployTarget?.exists("tok", "x")).toBe(false);

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("{}", { status: 500 }),
		);

		await expect(
			vercelProvider.deployTarget?.exists("tok", "x"),
		).rejects.toThrow("Project lookup failed (HTTP 500)");
	});

	it("create posts the project name and throws on failure", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));

		await vercelProvider.deployTarget?.create("tok", "hat-rec");

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.vercel.com/v9/projects",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer tok",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ name: "hat-rec" }),
			},
		);

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("{}", { status: 409 }),
		);

		await expect(
			vercelProvider.deployTarget?.create("tok", "hat-rec"),
		).rejects.toThrow("Project creation failed (HTTP 409)");
	});
});
