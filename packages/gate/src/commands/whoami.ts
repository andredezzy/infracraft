import * as p from "@clack/prompts";
import pc from "picocolors";

import { detectActiveAccount } from "../accounts/session";
import type { AccountStore } from "../accounts/store";
import type { GateProvider } from "../providers/provider";
import type { CommandSpec } from "../registry/command-spec";
import { type ResolveAccountOptions, resolveAccount } from "./resolve-account";
import { runAction } from "./run-action";

export async function runWhoami(
	provider: GateProvider,
	store: AccountStore,
	label: string | undefined,
	options?: ResolveAccountOptions,
): Promise<void> {
	const account = label
		? await resolveAccount(provider, store, label, options)
		: (detectActiveAccount(provider, store) ??
			(await resolveAccount(provider, store, undefined, options)));

	const valid = await provider.validate(account.session.token);

	p.log.message(`Label:    ${pc.bold(account.label)}`);
	p.log.message(`Identity: ${pc.bold(account.identity)}`);

	p.log.message(
		`Status:   ${valid ? pc.green("valid") : pc.red("invalid or expired")}`,
	);
}

export const whoamiCommandSpec: CommandSpec = {
	description: "Show and validate an account (defaults to active)",
	usage: "[label]",
	async run(context, args) {
		p.intro(`gate ${context.provider.binary} auth whoami`);

		await runAction(async () => {
			await runWhoami(context.provider, context.store, args[0], {
				interaction: context.interaction,
			});

			p.outro("Done!");
		});
	},
};
