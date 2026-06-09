import * as p from "@clack/prompts";
import pc from "picocolors";

import { detectActiveAccount } from "../accounts/session";
import type { AccountStore, GateAccount } from "../accounts/store";
import {
	migrateVergateAccounts,
	shouldOfferVergateMigration,
} from "../accounts/vergate-migration";
import type { GateProvider } from "../providers/provider";
import { Provider } from "../providers/provider";

/** One-time vergate adoption: offered before any interactive Vercel account
 * resolution while the store has no Vercel accounts. */
export async function maybeOfferVergateMigration(
	provider: GateProvider,
	store: AccountStore,
): Promise<void> {
	if (provider.id !== Provider.VERCEL || !shouldOfferVergateMigration(store)) {
		return;
	}

	const confirmed = await p.confirm({
		message: "Found vergate accounts — migrate them into gate?",
	});

	if (confirmed === true) {
		const count = migrateVergateAccounts(store);

		p.log.success(
			`Migrated ${count} account${count === 1 ? "" : "s"} from vergate.`,
		);
	}
}

/** Positional label → lookup; otherwise an interactive picker. Exits on cancel. */
export async function resolveAccount(
	provider: GateProvider,
	store: AccountStore,
	label: string | undefined,
): Promise<GateAccount> {
	await maybeOfferVergateMigration(provider, store);

	if (label) {
		const account = store.find(provider.id, label);

		if (!account) {
			throw new Error(`Account "${label}" not found for ${provider.name}.`);
		}

		return account;
	}

	const accounts = store.list(provider.id);

	if (accounts.length === 0) {
		const loginPath = [...provider.layout.authMount, "login"].join(" ");

		throw new Error(
			`No ${provider.name} accounts saved. Run \`gate ${provider.binary} ${loginPath}\` to add one.`,
		);
	}

	const active = detectActiveAccount(provider, store);

	const selected = await p.select({
		message: "Select account:",
		options: accounts.map((account) => ({
			label: `${account.label} ${pc.gray(`(${account.identity})`)}${account.label === active?.label ? pc.green(" ● active") : ""}`,
			value: account.label,
		})),
	});

	if (p.isCancel(selected)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}

	return store.find(provider.id, selected as string) as GateAccount;
}
