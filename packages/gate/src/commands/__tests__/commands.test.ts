import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", () => ({
	intro: vi.fn(),
	outro: vi.fn(),
	cancel: vi.fn(),
	isCancel: vi.fn(() => false),
	confirm: vi.fn(async () => true),
	text: vi.fn(async () => "picked-label"),
	select: vi.fn(async () => "a"),
	log: {
		info: vi.fn(),
		success: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		message: vi.fn(),
	},
}));

import * as p from "@clack/prompts";

import { AccountStore } from "../../accounts/store";
import type { GateProvider, ProviderSession } from "../../providers/provider";
import { Provider } from "../../providers/provider";
import { runImport } from "../import";
import { runList } from "../list";
import { runLogin } from "../login";
import { runLogout } from "../logout";
import { runSwitch } from "../switch";
import { runWhoami } from "../whoami";

let store: AccountStore;
let native: ProviderSession | null;

function fakeProvider(overrides: Partial<GateProvider> = {}): GateProvider {
	return {
		id: Provider.VERCEL,
		name: "Fake",
		binary: "fake",
		layout: { authMount: [], deployVerb: "deploy" },
		authFile: "/dev/null",
		loginArgv: ["fake", "login"],
		deployUrlPattern: /x/,
		login: vi.fn(async () => ({ token: "fresh" })),
		readNativeSession: () => native,
		writeNativeSession: vi.fn((session: ProviderSession) => {
			native = session;
		}),
		validate: vi.fn(async () => true),
		identity: vi.fn(async () => "andre"),
		deployCli: () => ({ argv: [], env: {} }),
		...overrides,
	};
}

function seed(label = "a", token = "t1"): void {
	store.add({
		provider: Provider.VERCEL,
		label,
		identity: "andre",
		session: { token },
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	store = new AccountStore(fs.mkdtempSync(path.join(os.tmpdir(), "gate-cmd-")));
	native = null;
	delete process.env.GATE_VERGATE_ACCOUNTS_FILE;
	process.env.GATE_VERGATE_ACCOUNTS_FILE = "/nonexistent/vergate-accounts.json";
});

describe("runLogin", () => {
	it("intercept-logins, labels, and stores the account", async () => {
		const provider = fakeProvider();

		await runLogin(provider, store);

		const saved = store.find(Provider.VERCEL, "picked-label");
		expect(saved?.identity).toBe("andre");
		expect(saved?.session.token).toBe("fresh");
	});
});

describe("runSwitch", () => {
	it("writes the chosen session into the native auth file", async () => {
		seed();

		await runSwitch(fakeProvider(), store, "a");

		expect(native?.token).toBe("t1");
	});

	it("errors on an unknown label", async () => {
		await expect(runSwitch(fakeProvider(), store, "ghost")).rejects.toThrow(
			/not found/,
		);
	});
});

describe("runLogout", () => {
	it("removes the account", async () => {
		seed();

		await runLogout(fakeProvider(), store, "a");

		expect(store.list(Provider.VERCEL)).toEqual([]);
	});
});

describe("runWhoami", () => {
	it("defaults to the active account", async () => {
		seed("a", "active-tok");
		seed("b", "other-tok");
		native = { token: "active-tok" };

		await runWhoami(fakeProvider(), store, undefined);

		expect(p.select).not.toHaveBeenCalled();
		expect(p.log.message).toHaveBeenCalledWith(expect.stringContaining("a"));
	});

	it("reports invalid status without throwing", async () => {
		seed();
		const provider = fakeProvider({ validate: vi.fn(async () => false) });

		await runWhoami(provider, store, "a");

		expect(p.log.message).toHaveBeenCalledWith(
			expect.stringContaining("invalid"),
		);
	});
});

describe("runList", () => {
	it("warns when empty", async () => {
		await runList(fakeProvider(), store);

		expect(p.log.warn).toHaveBeenCalled();
	});

	it("marks the active account", async () => {
		seed("a", "t1");
		seed("b", "t2");
		native = { token: "t2" };

		await runList(fakeProvider(), store);

		const lines = vi
			.mocked(p.log.message)
			.mock.calls.map((call) => String(call[0]));

		expect(lines.find((line) => line.includes("b"))).toContain("active");

		expect(
			lines.find((line) => line.includes("a") && !line.includes("b")),
		).not.toContain("active");
	});
});

describe("runImport", () => {
	it("imports the native session under a new label", async () => {
		native = { token: "native-tok" };

		await runImport(fakeProvider(), store);

		expect(store.find(Provider.VERCEL, "picked-label")?.session.token).toBe(
			"native-tok",
		);
	});

	it("updates tokens when the identity is already stored", async () => {
		seed();
		native = { token: "native-tok" };

		await runImport(fakeProvider(), store);

		expect(store.find(Provider.VERCEL, "a")?.session.token).toBe("native-tok");
		expect(p.text).not.toHaveBeenCalled();
	});

	it("throws without a native session", async () => {
		await expect(runImport(fakeProvider(), store)).rejects.toThrow(
			/No Fake CLI session/,
		);
	});
});

describe("vergate migration offer", () => {
	it("offers and migrates during list when the store is empty and vergate has accounts", async () => {
		const vergateDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "gate-cmd-vergate-"),
		);

		process.env.GATE_VERGATE_ACCOUNTS_FILE = path.join(
			vergateDir,
			"accounts.json",
		);

		fs.writeFileSync(
			process.env.GATE_VERGATE_ACCOUNTS_FILE,
			JSON.stringify({
				accounts: [{ label: "old", username: "andre", token: "t" }],
			}),
		);

		await runList(fakeProvider(), store);

		expect(p.confirm).toHaveBeenCalled();
		expect(store.find(Provider.VERCEL, "old")).toBeDefined();
	});
});
