import * as p from "@clack/prompts";
import { defineCommand } from "citty";
import pc from "picocolors";

import { refreshNativeSession } from "../accounts/discovery";
import type { AccountStore } from "../accounts/store";
import type { GateProvider } from "../providers/provider";
import { adoptSession } from "./adopt-session";
import { resolveDuplicateIdentities } from "./merge-duplicates";
import { runAction } from "./run-action";

export async function runImport(
	provider: GateProvider,
	store: AccountStore,
): Promise<void> {
	await resolveDuplicateIdentities(provider, store);

	let session = provider.readNativeSession();

	if (!session) {
		throw new Error(
			`No ${provider.name} CLI session found. Run \`${provider.loginArgv.join(" ")}\` first.`,
		);
	}

	if (!(await provider.validate(session.token))) {
		const refreshed = await refreshNativeSession(provider, session);

		if (!refreshed) {
			throw new Error(
				`The current ${provider.name} CLI session is invalid or expired.`,
			);
		}

		session = refreshed;
	}

	const identity = await provider.identity(session.token);

	p.log.success(`Found session for ${pc.green(identity)}.`);

	await adoptSession(provider, store, identity, session);
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
