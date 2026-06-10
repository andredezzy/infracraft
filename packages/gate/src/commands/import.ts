import * as p from "@clack/prompts";
import pc from "picocolors";

import { refreshNativeSession } from "../accounts/discovery";
import type { AccountStore } from "../accounts/store";
import type { GateProvider } from "../providers/provider";
import { type CommandSpec, InteractionMode } from "../registry/command-spec";
import { adoptSession } from "./adopt-session";
import { resolveDuplicateIdentities } from "./merge-duplicates";
import type { ResolveAccountOptions } from "./resolve-account";
import { runAction } from "./run-action";

export async function runImport(
	provider: GateProvider,
	store: AccountStore,
	options?: ResolveAccountOptions,
): Promise<void> {
	if (options?.interaction === InteractionMode.NON_INTERACTIVE) {
		throw new Error(
			`gate ${provider.binary} auth import requires an interactive terminal.`,
		);
	}

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

export const importCommandSpec: CommandSpec = {
	description: "Adopt the current native CLI session as a named account",
	usage: "",
	async run(context) {
		p.intro(`gate ${context.provider.binary} auth import`);

		await runAction(async () => {
			await runImport(context.provider, context.store, {
				interaction: context.interaction,
			});

			p.outro("Done!");
		});
	},
};
