import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeFakeProvider } from "../../providers/__tests__/fake-provider";
import type { GateProvider, ProviderSession } from "../../providers/provider";
import { Provider } from "../../providers/provider";
import { InteractionMode } from "../../registry/command-spec";
import { detectActiveAccount, ensureValidSession } from "../session";
import { AccountStore, type GateAccount } from "../store";

let store: AccountStore;
let native: ProviderSession | null;

function fakeProvider(overrides: Partial<GateProvider> = {}): GateProvider {
	return makeFakeProvider({
		login: vi.fn(async () => ({ token: "from-login" })),
		readNativeSession: () => native,
		writeNativeSession: vi.fn((session: ProviderSession) => {
			native = session;
		}),
		...overrides,
	});
}

function seed(session: ProviderSession): GateAccount {
	const account: GateAccount = {
		provider: Provider.VERCEL,
		label: "a",
		identity: "andre",
		session,
	};

	store.add(account);

	return account;
}

beforeEach(() => {
	store = new AccountStore(
		fs.mkdtempSync(path.join(os.tmpdir(), "gate-session-")),
	);

	native = null;
});

describe("detectActiveAccount", () => {
	it("matches the native token against stored accounts", () => {
		const account = seed({ token: "t1" });
		native = { token: "t1" };

		expect(detectActiveAccount(fakeProvider(), store)?.label).toBe(
			account.label,
		);
	});

	it("returns null when nothing matches", () => {
		seed({ token: "t1" });
		native = { token: "other" };

		expect(detectActiveAccount(fakeProvider(), store)).toBeNull();
	});

	it("returns null when there is no native session", () => {
		seed({ token: "t1" });

		expect(detectActiveAccount(fakeProvider(), store)).toBeNull();
	});
});

describe("ensureValidSession", () => {
	it("returns the account untouched when the token validates", async () => {
		const account = seed({ token: "good" });

		const result = await ensureValidSession(fakeProvider(), store, account);

		expect(result.session.token).toBe("good");
	});

	it("refreshes an expired token and persists it", async () => {
		const expired = Math.floor(Date.now() / 1000) - 10;

		const account = seed({
			token: "old",
			refreshToken: "r",
			expiresAt: expired,
		});

		const provider = fakeProvider({
			refresh: vi.fn(async () => ({
				token: "refreshed",
				refreshToken: "r2",
				expiresAt: 9999999999,
			})),
		});

		const result = await ensureValidSession(provider, store, account);

		expect(result.session.token).toBe("refreshed");
		expect(store.find(Provider.VERCEL, "a")?.session.token).toBe("refreshed");
	});

	it("writes through to the native file when the refreshed account was active", async () => {
		const expired = Math.floor(Date.now() / 1000) - 10;

		const account = seed({
			token: "old",
			refreshToken: "r",
			expiresAt: expired,
		});

		native = { token: "old" };

		const provider = fakeProvider({
			refresh: vi.fn(async () => ({
				token: "refreshed",
				expiresAt: 9999999999,
			})),
		});

		await ensureValidSession(provider, store, account);

		expect(native?.token).toBe("refreshed");
	});

	it("does not write through when the refreshed account was not active", async () => {
		const expired = Math.floor(Date.now() / 1000) - 10;

		const account = seed({
			token: "old",
			refreshToken: "r",
			expiresAt: expired,
		});

		native = { token: "someone-else" };

		const provider = fakeProvider({
			refresh: vi.fn(async () => ({
				token: "refreshed",
				expiresAt: 9999999999,
			})),
		});

		await ensureValidSession(provider, store, account);

		expect(native?.token).toBe("someone-else");
	});

	it("falls back to refresh when validation fails", async () => {
		const account = seed({ token: "dead", refreshToken: "r" });

		const provider = fakeProvider({
			validate: vi.fn(async (token: string) => token === "alive"),
			refresh: vi.fn(async () => ({ token: "alive" })),
		});

		const result = await ensureValidSession(provider, store, account);

		expect(result.session.token).toBe("alive");
	});

	it("recovers from a valid native session with the same identity", async () => {
		const account = seed({ token: "dead" });
		native = { token: "native-good" };

		const provider = fakeProvider({
			validate: vi.fn(async (token: string) => token === "native-good"),
		});

		const result = await ensureValidSession(provider, store, account);

		expect(result.session.token).toBe("native-good");
		expect(store.find(Provider.VERCEL, "a")?.session.token).toBe("native-good");
	});

	it("does not adopt a native session belonging to a different identity", async () => {
		const account = seed({ token: "dead" });
		native = { token: "native-good" };

		const provider = fakeProvider({
			validate: vi.fn(
				async (token: string) =>
					token === "native-good" || token === "from-login",
			),
			identity: vi.fn(async (token: string) =>
				token === "native-good" ? "stranger" : "andre",
			),
		});

		const result = await ensureValidSession(provider, store, account);

		expect(result.session.token).toBe("from-login");
	});

	it("falls through to login when identity cannot be confirmed mid-recovery", async () => {
		const account = seed({ token: "dead" });
		native = { token: "native-good" };

		const provider = fakeProvider({
			validate: vi.fn(async (token: string) => token !== "dead"),
			identity: vi.fn(async () => {
				throw new Error("revoked mid-flight");
			}),
		});

		const result = await ensureValidSession(provider, store, account);

		expect(result.session.token).toBe("from-login");
		expect(provider.login).toHaveBeenCalled();
	});

	it("falls back to a browser login as the last resort", async () => {
		const account = seed({ token: "dead" });

		const provider = fakeProvider({
			validate: vi.fn(async (token: string) => token === "from-login"),
			identity: vi.fn(async () => "andre"),
		});

		const result = await ensureValidSession(provider, store, account);

		expect(result.session.token).toBe("from-login");
		expect(provider.login).toHaveBeenCalled();
	});
});

describe("ensureValidSession non-interactive guard", () => {
	it("throws instead of opening a browser when NON_INTERACTIVE", async () => {
		const account = seed({ token: "dead" });

		const provider = fakeProvider({
			validate: vi.fn(async () => false),
		});

		await expect(
			ensureValidSession(provider, store, account, {
				interaction: InteractionMode.NON_INTERACTIVE,
			}),
		).rejects.toThrow(/gate fake auth login/);

		expect(provider.login).not.toHaveBeenCalled();
	});

	it("still browser-logins as the last resort when INTERACTIVE", async () => {
		const account = seed({ token: "dead" });

		const provider = fakeProvider({
			validate: vi.fn(async (token: string) => token === "from-login"),
		});

		const valid = await ensureValidSession(provider, store, account, {
			interaction: InteractionMode.INTERACTIVE,
		});

		expect(valid.session.token).toBe("from-login");

		expect(provider.login).toHaveBeenCalled();
	});

	it("defaults to INTERACTIVE when options are omitted (library back-compat)", async () => {
		const account = seed({ token: "dead" });

		const provider = fakeProvider({
			validate: vi.fn(async (token: string) => token === "from-login"),
		});

		const valid = await ensureValidSession(provider, store, account);

		expect(valid.session.token).toBe("from-login");
	});
});
