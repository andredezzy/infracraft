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
