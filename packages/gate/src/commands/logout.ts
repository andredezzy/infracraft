import * as p from "@clack/prompts";

import type { AccountStore } from "../accounts/store";
import type { GateProvider } from "../providers/provider";
import type { CommandSpec } from "../registry/command-spec";
import { type ResolveAccountOptions, resolveAccount } from "./resolve-account";
import { runAction } from "./run-action";

export async function runLogout(
	provider: GateProvider,
	store: AccountStore,
	label: string | undefined,
	options?: ResolveAccountOptions,
): Promise<void> {
	const account = await resolveAccount(provider, store, label, options);

	store.remove(provider.id, account.label);

	p.log.success(`Removed "${account.label}" (${account.identity}).`);
}

export const logoutCommandSpec: CommandSpec = {
	description: "Remove a stored account",
	usage: "[label]",
	async run(context, args) {
		p.intro(`gate ${context.provider.binary} auth logout`);

		await runAction(async () => {
			await runLogout(context.provider, context.store, args[0], {
				interaction: context.interaction,
			});

			p.outro("Done!");
		});
	},
};
