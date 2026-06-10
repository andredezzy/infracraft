#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";

import packageJson from "../package.json";
import { AccountStore } from "./accounts/store";
import { makeDeployCommand } from "./commands/deploy";
import { makeImportCommand } from "./commands/import";
import { makeListCommand } from "./commands/list";
import { makeLoginCommand } from "./commands/login";
import { makeLogoutCommand } from "./commands/logout";
import { makeSwitchCommand } from "./commands/switch";
import { makeWhoamiCommand } from "./commands/whoami";
import type { GateProvider } from "./providers/provider";
import { PROVIDERS } from "./providers/registry";

/** Builds one provider's namespace, mirroring the provider's own CLI tree:
 * auth verbs at `layout.authMount`, the deploy verb at the namespace root. */
export function makeProviderNamespace(
	provider: GateProvider,
	store = new AccountStore(),
) {
	const authVerbs = {
		login: makeLoginCommand(provider, store),
		logout: makeLogoutCommand(provider, store),
		switch: makeSwitchCommand(provider, store),
		whoami: makeWhoamiCommand(provider, store),
		list: makeListCommand(provider, store),
		import: makeImportCommand(provider, store),
	};

	const deploySubCommand = {
		[provider.layout.deployVerb]: makeDeployCommand(provider, store),
	};

	const authMountName = provider.layout.authMount[0];

	const mounted =
		authMountName === undefined
			? { ...authVerbs, ...deploySubCommand }
			: {
					[authMountName]: defineCommand({
						meta: {
							name: authMountName,
							description: `${provider.name} account management`,
						},
						subCommands: authVerbs,
					}),
					...deploySubCommand,
				};

	return defineCommand({
		meta: {
			name: provider.binary,
			description: `${provider.name} accounts + deploys`,
		},
		subCommands: mounted,
	});
}

export const main = defineCommand({
	meta: {
		name: "gate",
		version: packageJson.version,
		description:
			"Multi-account switcher + sandboxed deploys for Vercel, Railway, and Fly.io",
	},
	subCommands: Object.fromEntries(
		PROVIDERS.map((provider) => [
			provider.binary,
			makeProviderNamespace(provider),
		]),
	),
});

if (import.meta.main) {
	runMain(main);
}
