import * as p from "@clack/prompts";
import { defineCommand } from "citty";
import pc from "picocolors";

import type { AccountStore } from "../accounts/store";
import type { GateProvider } from "../providers/provider";
import { adoptSession } from "./adopt-session";
import { resolveDuplicateIdentities } from "./merge-duplicates";
import { runAction } from "./run-action";

export async function runLogin(
	provider: GateProvider,
	store: AccountStore,
): Promise<void> {
	await resolveDuplicateIdentities(provider, store);

	p.log.info(`Opening browser for ${provider.name} login...`);

	const session = await provider.login();
	const identity = await provider.identity(session.token);

	p.log.success(`Logged in as ${pc.green(identity)}`);

	await adoptSession(provider, store, identity, session);
}

export function makeLoginCommand(provider: GateProvider, store: AccountStore) {
	return defineCommand({
		meta: {
			name: "login",
			description: `Add a ${provider.name} account via browser login`,
		},
		async run() {
			p.intro(`gate ${provider.binary} login`);

			await runAction(async () => {
				await runLogin(provider, store);
				p.outro("Done!");
			});
		},
	});
}
