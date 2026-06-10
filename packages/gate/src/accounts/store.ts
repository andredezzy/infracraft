import { homedir } from "node:os";
import path from "node:path";

import { atomicWriteFile, readTextFile } from "../providers/auth-file";
import type { Provider, ProviderSession } from "../providers/provider";

export interface GateAccount {
	provider: Provider;
	/** Unique per provider. */
	label: string;
	/** Username/email captured at save time. */
	identity: string;
	session: ProviderSession;
}

interface StoreData {
	accounts: GateAccount[];
	declinedIdentities?: Partial<Record<Provider, string[]>>;
}

/** `GATE_CONFIG_DIR` overrides (tests); otherwise platform-conventional. */
function resolveConfigDir(): string {
	if (process.env.GATE_CONFIG_DIR) {
		return process.env.GATE_CONFIG_DIR;
	}

	return process.platform === "darwin"
		? path.join(homedir(), "Library", "Application Support", "gate")
		: path.join(homedir(), ".config", "gate");
}

/**
 * gate's multi-provider account store: one JSON file, plain sessions (matching
 * the native CLIs' own storage), mode 0600. No "active" pointer — active is
 * derived by matching the native auth file's token against stored accounts.
 */
export class AccountStore {
	private readonly file: string;

	constructor(directory: string = resolveConfigDir()) {
		this.file = path.join(directory, "accounts.json");
	}

	list(provider: Provider): GateAccount[] {
		return this.load().accounts.filter(
			(account) => account.provider === provider,
		);
	}

	find(provider: Provider, label: string): GateAccount | undefined {
		return this.list(provider).find((account) => account.label === label);
	}

	add(account: GateAccount): void {
		const data = this.load();

		const duplicate = data.accounts.some(
			(candidate) =>
				candidate.provider === account.provider &&
				candidate.label === account.label,
		);

		if (duplicate) {
			throw new Error(
				`Account "${account.label}" already exists for ${account.provider}.`,
			);
		}

		data.accounts.push(account);

		const declined = data.declinedIdentities?.[account.provider];

		if (declined) {
			data.declinedIdentities = {
				...data.declinedIdentities,
				[account.provider]: declined.filter(
					(identity) => identity !== account.identity,
				),
			};
		}

		this.save(data);
	}

	remove(provider: Provider, label: string): void {
		const data = this.load();

		const remaining = data.accounts.filter(
			(account) => !(account.provider === provider && account.label === label),
		);

		if (remaining.length === data.accounts.length) {
			throw new Error(`Account "${label}" not found for ${provider}.`);
		}

		this.save({ ...data, accounts: remaining });
	}

	updateSession(
		provider: Provider,
		label: string,
		session: ProviderSession,
	): void {
		const data = this.load();

		const account = data.accounts.find(
			(candidate) =>
				candidate.provider === provider && candidate.label === label,
		);

		if (!account) {
			return;
		}

		account.session = session;
		this.save(data);
	}

	isIdentityDeclined(provider: Provider, identity: string): boolean {
		return Boolean(
			this.load().declinedIdentities?.[provider]?.includes(identity),
		);
	}

	declineIdentity(provider: Provider, identity: string): void {
		const data = this.load();
		const declined = data.declinedIdentities ?? {};
		const identities = declined[provider] ?? [];

		if (!identities.includes(identity)) {
			identities.push(identity);
		}

		declined[provider] = identities;
		data.declinedIdentities = declined;

		this.save(data);
	}

	private load(): StoreData {
		const raw = readTextFile(this.file);

		if (raw === null) {
			return { accounts: [] };
		}

		try {
			const data = JSON.parse(raw) as StoreData;

			if (!Array.isArray(data.accounts)) {
				throw new Error("missing accounts array");
			}

			return data;
		} catch {
			throw new Error(
				`Accounts file is corrupted: ${this.file}\nDelete it and re-add your accounts.`,
			);
		}
	}

	private save(data: StoreData): void {
		atomicWriteFile(this.file, JSON.stringify(data, null, 2));
	}
}
