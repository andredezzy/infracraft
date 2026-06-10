import * as p from "@clack/prompts";
import { defineCommand } from "citty";
import pc from "picocolors";

import type { AccountStore } from "../accounts/store";
import type { GateProvider } from "../providers/provider";
import { promptLabelAndAdd } from "./adopt-session";
import { runAction } from "./run-action";

export async function runImport(
	provider: GateProvider,
	store: AccountStore,
): Promise<void> {
	const session = provider.readNativeSession();

	if (!session) {
		throw new Error(
			`No ${provider.name} CLI session found. Run \`${provider.loginArgv.join(" ")}\` first.`,
		);
	}

	if (!(await provider.validate(session.token))) {
		throw new Error(
			`The current ${provider.name} CLI session is invalid or expired.`,
		);
	}

	const identity = await provider.identity(session.token);

	const existing = store
		.list(provider.id)
		.find((account) => account.identity === identity);

	if (existing) {
		store.updateSession(provider.id, existing.label, session);

		p.log.success(
			`Updated tokens for "${pc.green(existing.label)}" (${identity}).`,
		);

		return;
	}

	p.log.success(`Found session for ${pc.green(identity)}.`);

	await promptLabelAndAdd(provider, store, identity, session);
}

export function makeImportCommand(provider: GateProvider, store: AccountStore) {
	return defineCommand({
		meta: {
			name: "import",
			description: `Import the native ${provider.name} CLI session`,
		},
		async run() {
			p.intro(`gate ${provider.binary} import`);

			await runAction(async () => {
				await runImport(provider, store);
				p.outro("Done!");
			});
		},
	});
}
