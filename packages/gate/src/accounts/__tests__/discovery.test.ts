import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GateProvider, ProviderSession } from "../../providers/provider";
import { Provider } from "../../providers/provider";
import { classifyNativeSession, NativeSessionStatus } from "../discovery";
import { AccountStore } from "../store";

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
		writeNativeSession: vi.fn(),
		validate: vi.fn(async () => true),
		identity: vi.fn(async () => "andre"),
		deployCli: () => ({ argv: [], env: {} }),
		...overrides,
	};
}

function seed(label = "a", token = "t1", identity = "andre"): void {
	store.add({ provider: Provider.VERCEL, label, identity, session: { token } });
}

beforeEach(() => {
	store = new AccountStore(
		fs.mkdtempSync(path.join(os.tmpdir(), "gate-discovery-")),
	);

	native = null;
});

describe("classifyNativeSession", () => {
	it("NONE when there is no native session — zero network", async () => {
		const provider = fakeProvider();

		const discovery = await classifyNativeSession(provider, store);

		expect(discovery.status).toBe(NativeSessionStatus.NONE);
		expect(provider.validate).not.toHaveBeenCalled();
	});

	it("MATCHES_STORED on a token match — zero network", async () => {
		seed("a", "t1");
		native = { token: "t1" };
		const provider = fakeProvider();

		const discovery = await classifyNativeSession(provider, store);

		expect(discovery.status).toBe(NativeSessionStatus.MATCHES_STORED);
		expect(provider.validate).not.toHaveBeenCalled();
		expect(provider.identity).not.toHaveBeenCalled();
	});

	it("INVALID when validation fails", async () => {
		native = { token: "foreign" };
		const provider = fakeProvider({ validate: vi.fn(async () => false) });

		expect((await classifyNativeSession(provider, store)).status).toBe(
			NativeSessionStatus.INVALID,
		);
	});

	it("INVALID when validation throws (offline)", async () => {
		native = { token: "foreign" };

		const provider = fakeProvider({
			validate: vi.fn(async () => {
				throw new Error("offline");
			}),
		});

		expect((await classifyNativeSession(provider, store)).status).toBe(
			NativeSessionStatus.INVALID,
		);
	});

	it("INVALID when identity resolution throws", async () => {
		native = { token: "foreign" };

		const provider = fakeProvider({
			identity: vi.fn(async () => {
				throw new Error("revoked");
			}),
		});

		expect((await classifyNativeSession(provider, store)).status).toBe(
			NativeSessionStatus.INVALID,
		);
	});

	it("TOKEN_VARIANT when the identity is already stored under a different token", async () => {
		seed("a", "t1", "andre");
		native = { token: "rotated" };
		const provider = fakeProvider();

		const discovery = await classifyNativeSession(provider, store);

		expect(discovery.status).toBe(NativeSessionStatus.TOKEN_VARIANT);
		expect(discovery.identity).toBe("andre");
	});

	it("DECLINED when the identity was declined before", async () => {
		store.declineIdentity(Provider.VERCEL, "andre");
		native = { token: "foreign" };
		const provider = fakeProvider();

		expect((await classifyNativeSession(provider, store)).status).toBe(
			NativeSessionStatus.DECLINED,
		);
	});

	it("UNKNOWN_IDENTITY for a valid session gate does not know", async () => {
		seed("a", "t1", "someone-else");
		native = { token: "foreign" };
		const provider = fakeProvider();

		const discovery = await classifyNativeSession(provider, store);

		expect(discovery.status).toBe(NativeSessionStatus.UNKNOWN_IDENTITY);
		expect(discovery.identity).toBe("andre");
		expect(discovery.session).toEqual({ token: "foreign" });
	});
});

describe("classifyNativeSession refresh fallback", () => {
	it("refreshes an expired native session, persists it, and classifies fresh", async () => {
		seed("a", "t1", "someone-else");
		native = { token: "expired", refreshToken: "r" };

		const provider = fakeProvider({
			validate: vi.fn(async (token: string) => token === "fresh"),
			refresh: vi.fn(async () => ({ token: "fresh", refreshToken: "r2" })),
		});

		const discovery = await classifyNativeSession(provider, store);

		expect(discovery.status).toBe(NativeSessionStatus.UNKNOWN_IDENTITY);
		expect(discovery.session).toEqual({ token: "fresh", refreshToken: "r2" });

		expect(provider.writeNativeSession).toHaveBeenCalledWith({
			token: "fresh",
			refreshToken: "r2",
		});

		expect(provider.identity).toHaveBeenCalledWith("fresh");
	});

	it("INVALID when the refresh also fails, without touching the native file", async () => {
		native = { token: "expired", refreshToken: "r" };

		const provider = fakeProvider({
			validate: vi.fn(async () => false),
			refresh: vi.fn(async () => null),
		});

		expect((await classifyNativeSession(provider, store)).status).toBe(
			NativeSessionStatus.INVALID,
		);

		expect(provider.writeNativeSession).not.toHaveBeenCalled();
	});

	it("does not attempt a refresh without a refresh token", async () => {
		native = { token: "expired" };
		const refresh = vi.fn(async () => ({ token: "fresh" }));

		const provider = fakeProvider({
			validate: vi.fn(async () => false),
			refresh,
		});

		expect((await classifyNativeSession(provider, store)).status).toBe(
			NativeSessionStatus.INVALID,
		);

		expect(refresh).not.toHaveBeenCalled();
	});
});

describe("TOKEN_VARIANT self-healing", () => {
	it("adopts the native session into every stored entry with that identity", async () => {
		seed("hc", "old-1", "andre");
		seed("hat", "old-2", "andre");
		seed("other", "t9", "someone-else");
		native = { token: "fresh-tok" };
		const provider = fakeProvider();

		const discovery = await classifyNativeSession(provider, store);

		expect(discovery.status).toBe(NativeSessionStatus.TOKEN_VARIANT);
		expect(store.find(Provider.VERCEL, "hc")?.session.token).toBe("fresh-tok");
		expect(store.find(Provider.VERCEL, "hat")?.session.token).toBe("fresh-tok");
		expect(store.find(Provider.VERCEL, "other")?.session.token).toBe("t9");
	});

	it("heals with the refreshed session when the native token was expired", async () => {
		seed("hc", "old-1", "andre");
		native = { token: "expired", refreshToken: "r" };

		const provider = fakeProvider({
			validate: vi.fn(async (token: string) => token === "fresh"),
			refresh: vi.fn(async () => ({ token: "fresh", refreshToken: "r2" })),
		});

		await classifyNativeSession(provider, store);

		expect(store.find(Provider.VERCEL, "hc")?.session).toEqual({
			token: "fresh",
			refreshToken: "r2",
		});
	});

	it("a second classification after healing is MATCHES_STORED", async () => {
		seed("hc", "old-1", "andre");
		native = { token: "fresh-tok" };
		const provider = fakeProvider();

		await classifyNativeSession(provider, store);

		const second = await classifyNativeSession(provider, store);
		expect(second.status).toBe(NativeSessionStatus.MATCHES_STORED);
	});
});
