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
import { makeFakeProvider } from "../../providers/__tests__/fake-provider";
import type { GateProvider, ProviderSession } from "../../providers/provider";
import { Provider } from "../../providers/provider";
import { runImport } from "../import";
import { runList } from "../list";
import { runLogin } from "../login";
import { runLogout } from "../logout";
import { maybeOfferAdoption, resolveAccount } from "../resolve-account";
import { runSwitch } from "../switch";
import { runWhoami } from "../whoami";

let store: AccountStore;
let native: ProviderSession | null;

function fakeProvider(overrides: Partial<GateProvider> = {}): GateProvider {
	return makeFakeProvider({
		login: vi.fn(async () => ({ token: "fresh" })),
		readNativeSession: () => native,
		writeNativeSession: vi.fn((session: ProviderSession) => {
			native = session;
		}),
		...overrides,
	});
}

function seed(label = "a", token = "t1", identity = "andre"): void {
	store.add({
		provider: Provider.VERCEL,
		label,
		identity,
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
		seed("a", "active-tok", "andre");
		seed("b", "other-tok", "bob");
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
		seed("a", "t1", "andre");
		seed("b", "t2", "bob");
		native = { token: "t2" };

		await runList(fakeProvider(), store);

		const lines = vi
			.mocked(p.log.message)
			.mock.calls.map((call) => String(call[0]));

		expect(lines.find((line) => line.includes("b"))).toContain("●");

		expect(
			lines.find((line) => line.includes("a") && !line.includes("b")),
		).not.toContain("●");
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

	it("updates tokens when the identity is already stored (via the update prompt)", async () => {
		seed();
		native = { token: "native-tok" };
		vi.mocked(p.select).mockResolvedValueOnce("UPDATE");

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

describe("native session discovery offer", () => {
	it("offers and imports an unknown native identity on yes", async () => {
		native = { token: "native-tok" };
		vi.mocked(p.confirm).mockResolvedValueOnce(true);

		await maybeOfferAdoption(fakeProvider(), store);

		const saved = store.find(Provider.VERCEL, "picked-label");
		expect(saved?.identity).toBe("andre");
		expect(saved?.session.token).toBe("native-tok");
	});

	it("remembers a decline and never asks again", async () => {
		native = { token: "native-tok" };
		vi.mocked(p.confirm).mockResolvedValueOnce(false);
		const provider = fakeProvider();

		await maybeOfferAdoption(provider, store);

		expect(store.isIdentityDeclined(Provider.VERCEL, "andre")).toBe(true);
		expect(store.list(Provider.VERCEL)).toEqual([]);

		await maybeOfferAdoption(provider, store);

		expect(p.confirm).toHaveBeenCalledTimes(1);
	});

	it("stays quiet for a token variant of a stored identity", async () => {
		seed("a", "t1");
		native = { token: "rotated" };

		await maybeOfferAdoption(fakeProvider(), store);

		expect(p.confirm).not.toHaveBeenCalled();
	});

	it("stays quiet when the native session is invalid", async () => {
		native = { token: "dead" };

		await maybeOfferAdoption(
			fakeProvider({ validate: vi.fn(async () => false) }),
			store,
		);

		expect(p.confirm).not.toHaveBeenCalled();
	});

	it("vergate migration runs first and pre-empts the native offer", async () => {
		const vergateDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "gate-cmd-vergate2-"),
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

		native = { token: "native-tok" };
		vi.mocked(p.confirm).mockResolvedValue(true);

		await maybeOfferAdoption(fakeProvider(), store);

		expect(store.find(Provider.VERCEL, "old")).toBeDefined();
		expect(p.confirm).toHaveBeenCalledTimes(1);
		expect(p.text).not.toHaveBeenCalled();
	});

	it("the empty-store error mentions both login and import", async () => {
		await expect(
			resolveAccount(fakeProvider(), store, undefined),
		).rejects.toThrow(/gate fake login.*gate fake import/s);
	});
});

describe("expired-but-refreshable native sessions", () => {
	it("runImport refreshes, persists to the native file, and stores fresh tokens", async () => {
		native = { token: "expired", refreshToken: "r" };

		const provider = fakeProvider({
			validate: vi.fn(async (token: string) => token === "fresh"),
			refresh: vi.fn(async () => ({ token: "fresh", refreshToken: "r2" })),
		});

		await runImport(provider, store);

		expect(store.find(Provider.VERCEL, "picked-label")?.session.token).toBe(
			"fresh",
		);

		expect(native?.token).toBe("fresh");
	});

	it("runImport still rejects a session that cannot be refreshed", async () => {
		native = { token: "expired", refreshToken: "r" };

		const provider = fakeProvider({
			validate: vi.fn(async () => false),
			refresh: vi.fn(async () => null),
		});

		await expect(runImport(provider, store)).rejects.toThrow(
			/invalid or expired/,
		);

		expect(native?.token).toBe("expired");
	});

	it("the discovery offer fires for a refreshed session and stores fresh tokens", async () => {
		native = { token: "expired", refreshToken: "r" };
		vi.mocked(p.confirm).mockResolvedValueOnce(true);

		const provider = fakeProvider({
			validate: vi.fn(async (token: string) => token === "fresh"),
			refresh: vi.fn(async () => ({ token: "fresh", refreshToken: "r2" })),
		});

		await maybeOfferAdoption(provider, store);

		expect(store.find(Provider.VERCEL, "picked-label")?.session.token).toBe(
			"fresh",
		);

		expect(native?.token).toBe("fresh");
	});
});

describe("active marker after a mandatory merge", () => {
	it("merges duplicate identities during list and marks the survivor", async () => {
		seed("hc", "old-1", "crew");
		seed("hat", "old-2", "crew");
		seed("dz0", "t9", "dz");
		native = { token: "fresh-tok" };
		vi.mocked(p.select).mockResolvedValueOnce("hc");
		const provider = fakeProvider({ identity: vi.fn(async () => "crew") });

		await runList(provider, store);

		expect(store.find(Provider.VERCEL, "hat")).toBeUndefined();
		expect(store.find(Provider.VERCEL, "hc")?.session.token).toBe("fresh-tok");

		const lines = vi
			.mocked(p.log.message)
			.mock.calls.map((call) => String(call[0]));

		expect(lines.find((line) => line.includes("hc"))).toContain("●");
		expect(lines.find((line) => line.includes("dz0"))).not.toContain("●");
		expect(p.confirm).not.toHaveBeenCalled();
	});
});

describe("adoptSession update-or-rename", () => {
	it("login with a stored identity updates the entry on UPDATE", async () => {
		seed("hc", "old", "andre");
		vi.mocked(p.select).mockResolvedValueOnce("UPDATE");

		await runLogin(fakeProvider(), store);

		expect(store.find(Provider.VERCEL, "hc")?.session.token).toBe("fresh");
		expect(store.list(Provider.VERCEL)).toHaveLength(1);
		expect(p.text).not.toHaveBeenCalled();
	});

	it("login with a stored identity renames the entry on RENAME", async () => {
		seed("hc", "old", "andre");
		vi.mocked(p.select).mockResolvedValueOnce("RENAME");

		await runLogin(fakeProvider(), store);

		expect(store.find(Provider.VERCEL, "hc")).toBeUndefined();

		expect(store.find(Provider.VERCEL, "picked-label")?.session.token).toBe(
			"fresh",
		);

		expect(store.list(Provider.VERCEL)).toHaveLength(1);
	});

	it("login with an unknown identity still goes through the label prompt", async () => {
		await runLogin(fakeProvider(), store);

		expect(store.find(Provider.VERCEL, "picked-label")?.identity).toBe("andre");
		expect(p.select).not.toHaveBeenCalled();
	});

	it("import with a stored identity renames on RENAME", async () => {
		seed("hc", "old", "andre");
		native = { token: "native-tok" };
		vi.mocked(p.select).mockResolvedValueOnce("RENAME");

		await runImport(fakeProvider(), store);

		expect(store.find(Provider.VERCEL, "picked-label")?.session.token).toBe(
			"native-tok",
		);

		expect(store.list(Provider.VERCEL)).toHaveLength(1);
	});
});

describe("mandatory duplicate merge", () => {
	it("prompts per group and keeps only the chosen survivor", async () => {
		seed("hc", "t1", "crew");
		seed("hat", "t2", "crew");
		seed("dz0", "t9", "dz");
		vi.mocked(p.select).mockResolvedValueOnce("hat");

		await maybeOfferAdoption(fakeProvider(), store);

		expect(store.find(Provider.VERCEL, "hc")).toBeUndefined();
		expect(store.find(Provider.VERCEL, "hat")?.session.token).toBe("t2");
		expect(store.find(Provider.VERCEL, "dz0")).toBeDefined();
	});

	it("handles multiple duplicate groups with one prompt each", async () => {
		seed("a1", "t1", "andre");
		seed("a2", "t2", "andre");
		seed("b1", "t3", "bob");
		seed("b2", "t4", "bob");

		vi.mocked(p.select).mockResolvedValueOnce("a1").mockResolvedValueOnce("b2");

		await maybeOfferAdoption(fakeProvider(), store);

		expect(store.list(Provider.VERCEL).map((account) => account.label)).toEqual(
			["a1", "b2"],
		);

		expect(p.select).toHaveBeenCalledTimes(2);
	});

	it("repairs a duplicate introduced by the vergate migration in the same run", async () => {
		const vergateDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "gate-cmd-vergate3-"),
		);

		process.env.GATE_VERGATE_ACCOUNTS_FILE = path.join(
			vergateDir,
			"accounts.json",
		);

		fs.writeFileSync(
			process.env.GATE_VERGATE_ACCOUNTS_FILE,
			JSON.stringify({
				accounts: [
					{ label: "old1", username: "andre", token: "t1" },
					{ label: "old2", username: "andre", token: "t2" },
				],
			}),
		);

		vi.mocked(p.confirm).mockResolvedValueOnce(true);
		vi.mocked(p.select).mockResolvedValueOnce("old2");

		await maybeOfferAdoption(fakeProvider(), store);

		expect(store.list(Provider.VERCEL).map((account) => account.label)).toEqual(
			["old2"],
		);
	});
});
