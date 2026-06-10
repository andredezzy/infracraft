import * as p from "@clack/prompts";
import pc from "picocolors";

import type { AccountStore } from "../accounts/store";
import type { GateProvider } from "../providers/provider";
import type { CommandSpec } from "../registry/command-spec";
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

export const loginCommandSpec: CommandSpec = {
	description: "Add an account via the provider's browser login",
	usage: "",
	async run(context) {
		p.intro(`gate ${context.provider.binary} auth login`);

		await runAction(async () => {
			await runLogin(context.provider, context.store);
			p.outro("Done!");
		});
	},
};
