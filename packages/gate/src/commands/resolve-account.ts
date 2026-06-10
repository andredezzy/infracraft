import * as p from "@clack/prompts";
import pc from "picocolors";
import {
	classifyNativeSession,
	NativeSessionStatus,
} from "../accounts/discovery";
import { detectActiveAccount } from "../accounts/session";
import type { AccountStore, GateAccount } from "../accounts/store";
import {
	migrateVergateAccounts,
	shouldOfferVergateMigration,
} from "../accounts/vergate-migration";
import type { GateProvider, ProviderSession } from "../providers/provider";
import { Provider } from "../providers/provider";
import { promptLabelAndAdd } from "./adopt-session";

/** One-time vergate adoption: offered before any interactive Vercel account
 * resolution while the store has no Vercel accounts. */
async function maybeOfferVergateMigration(
	provider: GateProvider,
	store: AccountStore,
): Promise<void> {
	if (provider.id !== Provider.VERCEL || !shouldOfferVergateMigration(store)) {
		return;
	}

	const confirmed = await p.confirm({
		message: "Found vergate accounts. Migrate them into gate?",
	});

	if (confirmed === true) {
		const count = migrateVergateAccounts(store);

		p.log.success(
			`Migrated ${count} account${count === 1 ? "" : "s"} from vergate.`,
		);
	}
}

/** Offers to import a valid native CLI session gate doesn't know. Declines
 * are remembered per identity; Ctrl-C aborts without remembering. */
async function maybeOfferNativeImport(
	provider: GateProvider,
	store: AccountStore,
): Promise<void> {
	const discovery = await classifyNativeSession(provider, store);

	if (discovery.status !== NativeSessionStatus.UNKNOWN_IDENTITY) {
		return;
	}

	const identity = discovery.identity as string;
	const session = discovery.session as ProviderSession;

	const confirmed = await p.confirm({
		message: `The ${provider.name} CLI is logged in as ${identity}. Import this account?`,
	});

	if (p.isCancel(confirmed)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}

	if (confirmed) {
		await promptLabelAndAdd(provider, store, identity, session);

		return;
	}

	store.declineIdentity(provider.id, identity);

	const importPath = [...provider.layout.authMount, "import"].join(" ");

	p.log.message(
		pc.gray(
			`Won't ask about ${identity} again. \`gate ${provider.binary} ${importPath}\` works anytime.`,
		),
	);
}

/** Cold-start adoption chain: vergate bulk migration first (it may make the
 * native identity known), then native-session discovery. */
export async function maybeOfferAdoption(
	provider: GateProvider,
	store: AccountStore,
): Promise<void> {
	await maybeOfferVergateMigration(provider, store);
	await maybeOfferNativeImport(provider, store);
}

/** Positional label → lookup; otherwise an interactive picker. Exits on cancel. */
export async function resolveAccount(
	provider: GateProvider,
	store: AccountStore,
	label: string | undefined,
): Promise<GateAccount> {
	await maybeOfferAdoption(provider, store);

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
		const importPath = [...provider.layout.authMount, "import"].join(" ");

		throw new Error(
			`No ${provider.name} accounts saved. Run \`gate ${provider.binary} ${loginPath}\` to add one, or \`gate ${provider.binary} ${importPath}\` to adopt the current CLI session.`,
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
