import type { GateProvider } from "../providers/provider";
import type { AccountStore, GateAccount } from "./store";

/**
 * Groups a provider's accounts by identity and returns only the groups with
 * more than one entry, each in stored order. Local-only: one store read,
 * zero network.
 */
export function findDuplicateIdentityGroups(
	provider: GateProvider,
	store: AccountStore,
): GateAccount[][] {
	const groups = new Map<string, GateAccount[]>();

	for (const account of store.list(provider.id)) {
		const group = groups.get(account.identity) ?? [];

		group.push(account);
		groups.set(account.identity, group);
	}

	return [...groups.values()].filter((group) => group.length > 1);
}
