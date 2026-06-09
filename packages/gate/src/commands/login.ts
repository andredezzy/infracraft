import * as p from "@clack/prompts";
import { defineCommand } from "citty";
import pc from "picocolors";

import type { AccountStore } from "../accounts/store";
import type { GateProvider } from "../providers/provider";

export async function runLogin(
	provider: GateProvider,
	store: AccountStore,
): Promise<void> {
	p.log.info(`Opening browser for ${provider.name} login...`);

	const session = await provider.login();
	const identity = await provider.identity(session.token);

	p.log.success(`Logged in as ${pc.green(identity)}`);

	const label = await p.text({
		message: "Label for this account:",
		validate: (value) => {
			if (!value?.trim()) {
				return "Label cannot be empty";
			}

			if (store.find(provider.id, value.trim())) {
				return "An account with this label already exists";
			}
		},
	});

	if (p.isCancel(label)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}

	store.add({
		provider: provider.id,
		label: (label as string).trim(),
		identity,
		session,
	});

	p.log.success(`Account "${(label as string).trim()}" added.`);
}

export function makeLoginCommand(provider: GateProvider, store: AccountStore) {
	return defineCommand({
		meta: {
			name: "login",
			description: `Add a ${provider.name} account via browser login`,
		},
		async run() {
			p.intro(`gate ${provider.binary} login`);
			await runLogin(provider, store);
			p.outro("Done!");
		},
	});
}
