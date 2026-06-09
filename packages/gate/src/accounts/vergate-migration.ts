import { homedir } from "node:os";
import path from "node:path";

import { readTextFile } from "../providers/auth-file";
import { Provider } from "../providers/provider";
import type { AccountStore, GateAccount } from "./store";

interface VergateAccount {
	label: string;
	username: string;
	token: string;
	refreshToken?: string;
	expiresAt?: number;
}

/** `GATE_VERGATE_ACCOUNTS_FILE` overrides (tests); otherwise vergate's path. */
function resolveVergateFile(): string {
	if (process.env.GATE_VERGATE_ACCOUNTS_FILE) {
		return process.env.GATE_VERGATE_ACCOUNTS_FILE;
	}

	const dir =
		process.platform === "darwin"
			? path.join(homedir(), "Library", "Application Support", "vergate")
			: path.join(homedir(), ".config", "vergate");

	return path.join(dir, "accounts.json");
}

/** Reads vergate's store read-only and maps it to gate accounts. Best-effort:
 * any problem yields [] — migration must never block gate. */
export function readVergateAccounts(): GateAccount[] {
	try {
		const raw = readTextFile(resolveVergateFile());

		if (raw === null) {
			return [];
		}

		const data = JSON.parse(raw) as { accounts?: VergateAccount[] };

		if (!Array.isArray(data.accounts)) {
			return [];
		}

		return data.accounts
			.filter(
				(account) =>
					typeof account.label === "string" &&
					account.label.length > 0 &&
					typeof account.username === "string" &&
					typeof account.token === "string" &&
					account.token.length > 0,
			)
			.map((account) => ({
				provider: Provider.VERCEL,
				label: account.label,
				identity: account.username,
				session: {
					token: account.token,
					refreshToken: account.refreshToken,
					expiresAt: account.expiresAt,
				},
			}));
	} catch {
		return [];
	}
}

/** True when a one-time migration offer makes sense: gate has no Vercel
 * accounts yet, and vergate has some. */
export function shouldOfferVergateMigration(store: AccountStore): boolean {
	return (
		store.list(Provider.VERCEL).length === 0 && readVergateAccounts().length > 0
	);
}

/** Copies vergate accounts into the store (skipping label collisions). */
export function migrateVergateAccounts(store: AccountStore): number {
	let migrated = 0;

	for (const account of readVergateAccounts()) {
		if (!store.find(Provider.VERCEL, account.label)) {
			store.add(account);
			migrated += 1;
		}
	}

	return migrated;
}
