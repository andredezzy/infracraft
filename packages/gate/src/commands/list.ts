import * as p from "@clack/prompts";
import { defineCommand } from "citty";
import pc from "picocolors";

import { detectActiveAccount } from "../accounts/session";
import type { AccountStore } from "../accounts/store";
import type { GateProvider } from "../providers/provider";
import { maybeOfferAdoption } from "./resolve-account";
import { runAction } from "./run-action";

export async function runList(
	provider: GateProvider,
	store: AccountStore,
): Promise<void> {
	await maybeOfferAdoption(provider, store);

	const accounts = store.list(provider.id);

	if (accounts.length === 0) {
		p.log.warn(`No ${provider.name} accounts saved.`);

		return;
	}

	const active = detectActiveAccount(provider, store);

	for (const account of accounts) {
		const marker = account.label === active?.label ? pc.green(" ● active") : "";

		p.log.message(
			`${pc.bold(account.label)}  ${pc.gray(account.identity)}${marker}`,
		);
	}
}

export function makeListCommand(provider: GateProvider, store: AccountStore) {
	return defineCommand({
		meta: {
			name: "list",
			description: `List stored ${provider.name} accounts`,
		},
		async run() {
			p.intro(`gate ${provider.binary} list`);

			await runAction(async () => {
				await runList(provider, store);
				p.outro("Done!");
			});
		},
	});
}
