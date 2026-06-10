import * as p from "@clack/prompts";
import { defineCommand } from "citty";

import type { AccountStore } from "../accounts/store";
import type { GateProvider } from "../providers/provider";
import type { CommandSpec } from "../registry/command-spec";
import { resolveAccount } from "./resolve-account";
import { runAction } from "./run-action";

export async function runLogout(
	provider: GateProvider,
	store: AccountStore,
	label: string | undefined,
): Promise<void> {
	const account = await resolveAccount(provider, store, label);

	store.remove(provider.id, account.label);

	p.log.success(`Removed "${account.label}" (${account.identity}).`);
}

export const logoutCommandSpec: CommandSpec = {
	description: "Remove a stored account",
	usage: "[label]",
	async run(context, args) {
		p.intro(`gate ${context.provider.binary} auth logout`);

		await runAction(async () => {
			await runLogout(context.provider, context.store, args[0]);
			p.outro("Done!");
		});
	},
};

export function makeLogoutCommand(provider: GateProvider, store: AccountStore) {
	return defineCommand({
		meta: {
			name: "logout",
			description: `Remove a stored ${provider.name} account`,
		},
		args: {
			label: {
				type: "positional",
				description: "Account label",
				required: false,
			},
		},
		async run({ args }) {
			p.intro(`gate ${provider.binary} logout`);

			await runAction(async () => {
				await runLogout(provider, store, args.label as string | undefined);
				p.outro("Done!");
			});
		},
	});
}
