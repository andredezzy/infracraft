import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import { flyProvider } from "../fly";
import { Provider } from "../provider";

let dir: string;
let file: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-fly-"));
	file = path.join(dir, "config.yml");
	process.env.GATE_FLY_CONFIG_FILE = file;
});

afterEach(() => {
	delete process.env.GATE_FLY_CONFIG_FILE;
	vi.restoreAllMocks();
});

describe("flyProvider identity card", () => {
	it("declares the contract surface", () => {
		expect(flyProvider.id).toBe(Provider.FLY);
		expect(flyProvider.layout).toEqual({
			authMount: ["auth"],
			deployVerb: "deploy",
		});
		expect(flyProvider.loginArgv).toEqual(["fly", "auth", "login"]);
		expect(flyProvider.refresh).toBeUndefined();
	});
});

describe("native session round-trip", () => {
	it("reads access_token from the YAML config", () => {
		fs.writeFileSync(file, 'access_token: "fly-tok"\nautoupdate: true\n');

		expect(flyProvider.readNativeSession()).toEqual({ token: "fly-tok" });
	});

	it("reads null when missing or tokenless", () => {
		expect(flyProvider.readNativeSession()).toBeNull();

		fs.writeFileSync(file, "autoupdate: true\n");
		expect(flyProvider.readNativeSession()).toBeNull();
	});

	it("writeNativeSession preserves unrelated YAML keys", () => {
		fs.writeFileSync(file, 'access_token: "old"\nautoupdate: true\n');

		flyProvider.writeNativeSession({ token: "new" });

		const written = parse(fs.readFileSync(file, "utf-8"));
		expect(written.access_token).toBe("new");
		expect(written.autoupdate).toBe(true);
	});

	it("writeNativeSession works on a fresh config", () => {
		flyProvider.writeNativeSession({ token: "new" });

		const written = parse(fs.readFileSync(file, "utf-8"));
		expect(written.access_token).toBe("new");
	});
});

describe("API calls", () => {
	it("validate + identity query the GraphQL viewer", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(() =>
				Promise.resolve(
					new Response(
						JSON.stringify({ data: { viewer: { email: "a@b.c" } } }),
						{ status: 200 },
					),
				),
			);

		expect(await flyProvider.validate("tok")).toBe(true);
		expect(await flyProvider.identity("tok")).toBe("a@b.c");
		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.fly.io/graphql");
	});

	it("validate is false on GraphQL errors and on network error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ errors: [{ message: "Unauthorized" }] }), {
				status: 200,
			}),
		);

		expect(await flyProvider.validate("tok")).toBe(false);

		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
		expect(await flyProvider.validate("tok")).toBe(false);
	});

	it("identity throws when the viewer has no email", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ data: { viewer: {} } }), { status: 200 }),
		);

		await expect(flyProvider.identity("tok")).rejects.toThrow(
			/failed to resolve/i,
		);
	});
});

describe("deployCli", () => {
	it("injects FLY_API_TOKEN env and forwards passthrough args", () => {
		const command = flyProvider.deployCli({
			token: "tok",
			passthroughArgs: ["--remote-only"],
		});

		expect(command.argv).toEqual(["fly", "deploy", "--remote-only"]);
		expect(command.env).toEqual({ FLY_API_TOKEN: "tok" });
	});
});
