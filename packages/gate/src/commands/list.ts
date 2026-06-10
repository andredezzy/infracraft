import * as p from "@clack/prompts";
import pc from "picocolors";

import type { AccountStore } from "../accounts/store";
import type { GateProvider } from "../providers/provider";
import type { CommandSpec } from "../registry/command-spec";
import {
	maybeOfferAdoption,
	type ResolveAccountOptions,
} from "./resolve-account";
import { runAction } from "./run-action";

export async function runList(
	provider: GateProvider,
	store: AccountStore,
	options?: ResolveAccountOptions,
): Promise<void> {
	await maybeOfferAdoption(provider, store, options);

	const accounts = store.list(provider.id);

	if (accounts.length === 0) {
		p.log.warn(`No ${provider.name} accounts saved.`);

		return;
	}

	const nativeToken = provider.readNativeSession()?.token;

	for (const account of accounts) {
		const isActive = account.session.token === nativeToken;

		p.log.message(
			isActive
				? pc.green(`${pc.bold(account.label)}  ${account.identity} ●`)
				: `${pc.bold(account.label)}  ${pc.gray(account.identity)}`,
		);
	}
}

export const listCommandSpec: CommandSpec = {
	description: "List stored accounts with the active marker",
	usage: "",
	async run(context) {
		p.intro(`gate ${context.provider.binary} auth list`);

		await runAction(async () => {
			await runList(context.provider, context.store, {
				interaction: context.interaction,
			});

			p.outro("Done!");
		});
	},
};
