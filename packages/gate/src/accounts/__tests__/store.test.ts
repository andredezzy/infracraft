import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { Provider } from "../../providers/provider";
import { AccountStore, type GateAccount } from "../store";

let dir: string;
let store: AccountStore;

const personal: GateAccount = {
	provider: Provider.VERCEL,
	label: "personal",
	identity: "andre",
	session: { token: "tok-1" },
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-store-"));
	store = new AccountStore(dir);
});

describe("AccountStore", () => {
	it("starts empty", () => {
		expect(store.list(Provider.VERCEL)).toEqual([]);
	});

	it("adds and lists per provider", () => {
		store.add(personal);
		store.add({ ...personal, provider: Provider.RAILWAY, label: "rw" });

		expect(store.list(Provider.VERCEL)).toEqual([personal]);
		expect(store.list(Provider.RAILWAY)).toHaveLength(1);
	});

	it("rejects a duplicate label within a provider", () => {
		store.add(personal);

		expect(() => store.add({ ...personal, identity: "other" })).toThrow(
			/already exists/,
		);
	});

	it("allows the same label across providers", () => {
		store.add(personal);

		expect(() =>
			store.add({ ...personal, provider: Provider.FLY }),
		).not.toThrow();
	});

	it("finds by label", () => {
		store.add(personal);

		expect(store.find(Provider.VERCEL, "personal")?.identity).toBe("andre");
		expect(store.find(Provider.VERCEL, "absent")).toBeUndefined();
	});

	it("removes by label and throws on a miss", () => {
		store.add(personal);
		store.remove(Provider.VERCEL, "personal");

		expect(store.list(Provider.VERCEL)).toEqual([]);

		expect(() => store.remove(Provider.VERCEL, "personal")).toThrow(
			/not found/,
		);
	});

	it("updates a session in place", () => {
		store.add(personal);

		store.updateSession(Provider.VERCEL, "personal", {
			token: "tok-2",
			expiresAt: 99,
		});

		expect(store.find(Provider.VERCEL, "personal")?.session).toEqual({
			token: "tok-2",
			expiresAt: 99,
		});
	});

	it("persists across instances", () => {
		store.add(personal);

		expect(new AccountStore(dir).list(Provider.VERCEL)).toEqual([personal]);
	});

	it("errors loudly on a corrupted file", () => {
		fs.writeFileSync(path.join(dir, "accounts.json"), "{nope");

		expect(() => store.list(Provider.VERCEL)).toThrow(/corrupted/);
	});

	it("writes the file with mode 0600", () => {
		store.add(personal);

		expect(fs.statSync(path.join(dir, "accounts.json")).mode & 0o777).toBe(
			0o600,
		);
	});

	it("honors GATE_CONFIG_DIR for the default directory", () => {
		process.env.GATE_CONFIG_DIR = dir;

		try {
			const defaultStore = new AccountStore();
			defaultStore.add(personal);

			expect(fs.existsSync(path.join(dir, "accounts.json"))).toBe(true);
		} finally {
			delete process.env.GATE_CONFIG_DIR;
		}
	});
});
