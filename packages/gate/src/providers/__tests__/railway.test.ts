import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Provider } from "../provider";
import { railwayProvider } from "../railway";

let dir: string;
let file: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-railway-"));
	file = path.join(dir, "config.json");
	process.env.GATE_RAILWAY_CONFIG_FILE = file;
});

afterEach(() => {
	delete process.env.GATE_RAILWAY_CONFIG_FILE;
	vi.restoreAllMocks();
});

describe("railwayProvider identity card", () => {
	it("declares the contract surface", () => {
		expect(railwayProvider.id).toBe(Provider.RAILWAY);
		expect(railwayProvider.layout).toEqual({ authMount: [], deployVerb: "up" });
		expect(railwayProvider.loginArgv).toEqual(["railway", "login"]);
		expect(railwayProvider.refresh).toBeUndefined();
	});
});

describe("native session round-trip", () => {
	it("reads the token from user.token", () => {
		fs.writeFileSync(
			file,
			JSON.stringify({ projects: { p: 1 }, user: { token: "rw-tok" } }),
		);

		expect(railwayProvider.readNativeSession()).toEqual({ token: "rw-tok" });
	});

	it("reads null when missing or tokenless", () => {
		expect(railwayProvider.readNativeSession()).toBeNull();

		fs.writeFileSync(file, JSON.stringify({ projects: {} }));
		expect(railwayProvider.readNativeSession()).toBeNull();
	});

	it("writeNativeSession preserves unrelated config (projects map)", () => {
		fs.writeFileSync(
			file,
			JSON.stringify({
				projects: { keep: "me" },
				user: { token: "old", name: "x" },
			}),
		);

		railwayProvider.writeNativeSession({ token: "new" });

		const written = JSON.parse(fs.readFileSync(file, "utf-8"));
		expect(written.projects).toEqual({ keep: "me" });
		expect(written.user.token).toBe("new");
		expect(written.user.name).toBe("x");
	});
});

describe("API calls", () => {
	it("validate + identity query the GraphQL me endpoint", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ data: { me: { email: "a@b.c" } } }), {
				status: 200,
			}),
		);

		expect(await railwayProvider.validate("tok")).toBe(true);
		expect(await railwayProvider.identity("tok")).toBe("a@b.c");

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://backboard.railway.com/graphql/v2");
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer tok",
		);
	});

	it("validate is false when GraphQL returns errors", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({ errors: [{ message: "Not Authorized" }] }),
				{ status: 200 },
			),
		);

		expect(await railwayProvider.validate("tok")).toBe(false);
	});
});

describe("deployCli", () => {
	it("injects RAILWAY_API_TOKEN env and forwards passthrough args", () => {
		const command = railwayProvider.deployCli({
			token: "tok",
			passthroughArgs: ["--detach"],
		});

		expect(command.argv).toEqual(["railway", "up", "--detach"]);
		expect(command.env).toEqual({ RAILWAY_API_TOKEN: "tok" });
	});
});
