import * as p from "@clack/prompts";
import pc from "picocolors";

import { ensureValidSession } from "../accounts/session";
import type { AccountStore } from "../accounts/store";
import type { GateProvider } from "../providers/provider";
import type { CommandSpec } from "../registry/command-spec";
import { type ResolveAccountOptions, resolveAccount } from "./resolve-account";
import { runAction } from "./run-action";

export async function runSwitch(
	provider: GateProvider,
	store: AccountStore,
	label: string | undefined,
	options?: ResolveAccountOptions,
): Promise<void> {
	const account = await resolveAccount(provider, store, label, options);
	const valid = await ensureValidSession(provider, store, account, options);

	provider.writeNativeSession(valid.session);

	p.log.success(
		`${provider.binary} → ${pc.bold(valid.label)} ${pc.gray(`(${valid.identity})`)}`,
	);
}

export const switchCommandSpec: CommandSpec = {
	description: "Write a stored account's session into the native CLI",
	usage: "[label]",
	async run(context, args) {
		p.intro(`gate ${context.provider.binary} auth switch`);

		await runAction(async () => {
			await runSwitch(context.provider, context.store, args[0], {
				interaction: context.interaction,
			});

			p.outro("Done!");
		});
	},
};
