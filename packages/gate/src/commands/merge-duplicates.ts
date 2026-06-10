import * as p from "@clack/prompts";

import { findDuplicateIdentityGroups } from "../accounts/duplicates";
import type { AccountStore } from "../accounts/store";
import type { GateProvider } from "../providers/provider";

/**
 * Mandatory repair: a provider identity may appear only once. For each
 * duplicate group the only choice is which label survives — the others are
 * removed. Ctrl-C aborts the command; the next interactive command prompts
 * again.
 */
export async function resolveDuplicateIdentities(
	provider: GateProvider,
	store: AccountStore,
): Promise<void> {
	for (const group of findDuplicateIdentityGroups(provider, store)) {
		const labels = group.map((account) => account.label);

		const survivor = await p.select({
			message: `${labels.join(" and ")} are both ${group[0]?.identity}. Keep which label?`,
			options: labels.map((label) => ({ label, value: label })),
		});

		if (p.isCancel(survivor)) {
			p.cancel("Cancelled.");
			process.exit(0);
		}

		for (const account of group) {
			if (account.label !== survivor) {
				store.remove(provider.id, account.label);
			}
		}

		const removed = labels.filter((label) => label !== survivor);

		p.log.success(
			`Merged into "${survivor as string}". Removed: ${removed.join(", ")}.`,
		);
	}
}
