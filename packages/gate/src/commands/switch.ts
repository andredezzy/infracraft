import * as p from "@clack/prompts";
import { defineCommand } from "citty";
import pc from "picocolors";

import { ensureValidSession } from "../accounts/session";
import type { AccountStore } from "../accounts/store";
import type { GateProvider } from "../providers/provider";
import type { CommandSpec } from "../registry/command-spec";
import { resolveAccount } from "./resolve-account";
import { runAction } from "./run-action";

export async function runSwitch(
	provider: GateProvider,
	store: AccountStore,
	label: string | undefined,
): Promise<void> {
	const account = await resolveAccount(provider, store, label);
	const valid = await ensureValidSession(provider, store, account);

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
			await runSwitch(context.provider, context.store, args[0]);
			p.outro("Done!");
		});
	},
};

export function makeSwitchCommand(provider: GateProvider, store: AccountStore) {
	return defineCommand({
		meta: {
			name: "switch",
			description: `Switch the native ${provider.name} CLI to a stored account`,
		},
		args: {
			label: {
				type: "positional",
				description: "Account label",
				required: false,
			},
		},
		async run({ args }) {
			p.intro(`gate ${provider.binary} switch`);

			await runAction(async () => {
				await runSwitch(provider, store, args.label as string | undefined);
				p.outro("Done!");
			});
		},
	});
}
