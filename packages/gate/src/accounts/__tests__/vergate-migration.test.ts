import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Provider } from "../../providers/provider";
import { AccountStore } from "../store";
import {
	migrateVergateAccounts,
	readVergateAccounts,
	shouldOfferVergateMigration,
} from "../vergate-migration";

let dir: string;
let storeDir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-vergate-"));
	storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-vergate-store-"));
	process.env.GATE_VERGATE_ACCOUNTS_FILE = path.join(dir, "accounts.json");
});

afterEach(() => {
	delete process.env.GATE_VERGATE_ACCOUNTS_FILE;
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(storeDir, { recursive: true, force: true });
});

function writeVergateFile(accounts: unknown): void {
	fs.writeFileSync(
		process.env.GATE_VERGATE_ACCOUNTS_FILE as string,
		JSON.stringify({ accounts }),
	);
}

describe("readVergateAccounts", () => {
	it("returns [] when vergate was never installed", () => {
		expect(readVergateAccounts()).toEqual([]);
	});

	it("maps vergate accounts to GateAccounts", () => {
		writeVergateFile([
			{
				label: "personal",
				username: "andre",
				token: "t",
				refreshToken: "r",
				expiresAt: 5,
			},
			{ label: "work", username: "andre-work", token: "t2" },
		]);

		const accounts = readVergateAccounts();

		expect(accounts).toEqual([
			{
				provider: Provider.VERCEL,
				label: "personal",
				identity: "andre",
				session: { token: "t", refreshToken: "r", expiresAt: 5 },
			},
			{
				provider: Provider.VERCEL,
				label: "work",
				identity: "andre-work",
				session: { token: "t2", refreshToken: undefined, expiresAt: undefined },
			},
		]);
	});

	it("returns [] for a corrupted file (never blocks gate)", () => {
		fs.writeFileSync(
			process.env.GATE_VERGATE_ACCOUNTS_FILE as string,
			"{broken",
		);

		expect(readVergateAccounts()).toEqual([]);
	});

	it("skips malformed entries (missing token or label)", () => {
		writeVergateFile([
			{ label: "good", username: "andre", token: "t" },
			{ label: "no-token", username: "andre" },
			{ username: "no-label", token: "t2" },
			{ label: "", username: "empty-label", token: "t3" },
		]);

		const accounts = readVergateAccounts();

		expect(accounts).toHaveLength(1);
		expect(accounts[0]?.label).toBe("good");
	});
});

describe("shouldOfferVergateMigration", () => {
	it("is true only when gate has no Vercel accounts and vergate has some", () => {
		const store = new AccountStore(storeDir);
		writeVergateFile([{ label: "a", username: "u", token: "t" }]);

		expect(shouldOfferVergateMigration(store)).toBe(true);

		store.add({
			provider: Provider.VERCEL,
			label: "x",
			identity: "u",
			session: { token: "t" },
		});

		expect(shouldOfferVergateMigration(store)).toBe(false);
	});

	it("is false when vergate has nothing", () => {
		expect(shouldOfferVergateMigration(new AccountStore(storeDir))).toBe(false);
	});
});

describe("migrateVergateAccounts", () => {
	it("copies accounts, skipping label collisions, and reports the count", () => {
		const store = new AccountStore(storeDir);

		store.add({
			provider: Provider.VERCEL,
			label: "work",
			identity: "pre",
			session: { token: "pre" },
		});

		writeVergateFile([
			{ label: "personal", username: "andre", token: "t" },
			{ label: "work", username: "andre-work", token: "t2" },
		]);

		const migrated = migrateVergateAccounts(store);

		expect(migrated).toBe(1);
		expect(store.find(Provider.VERCEL, "personal")?.identity).toBe("andre");
		expect(store.find(Provider.VERCEL, "work")?.identity).toBe("pre");
	});
});
