import * as p from "@clack/prompts";
import { defineCommand } from "citty";
import pc from "picocolors";

import { detectActiveAccount } from "../accounts/session";
import type { AccountStore } from "../accounts/store";
import type { GateProvider } from "../providers/provider";
import { resolveAccount } from "./resolve-account";

export async function runWhoami(
	provider: GateProvider,
	store: AccountStore,
	label: string | undefined,
): Promise<void> {
	const account = label
		? await resolveAccount(provider, store, label)
		: (detectActiveAccount(provider, store) ??
			(await resolveAccount(provider, store, undefined)));

	const valid = await provider.validate(account.session.token);

	p.log.message(`Label:    ${pc.bold(account.label)}`);
	p.log.message(`Identity: ${pc.bold(account.identity)}`);
	p.log.message(
		`Status:   ${valid ? pc.green("valid") : pc.red("invalid or expired")}`,
	);
}

export function makeWhoamiCommand(provider: GateProvider, store: AccountStore) {
	return defineCommand({
		meta: {
			name: "whoami",
			description: `Show and validate a ${provider.name} account`,
		},
		args: {
			label: {
				type: "positional",
				description: "Account label",
				required: false,
			},
		},
		async run({ args }) {
			p.intro(`gate ${provider.binary} whoami`);
			await runWhoami(provider, store, args.label as string | undefined);
			p.outro("Done!");
		},
	});
}
