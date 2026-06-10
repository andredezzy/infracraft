import type { GateProvider } from "../providers/provider";
import type { GateAuthVerb } from "../routing/route-command";
import type { CommandRegistry } from "./command-registry";
import type { CommandSpec } from "./command-spec";

function formatRow(left: string, description: string): string {
	return `  ${left.padEnd(34)}${description}`;
}

export function renderRootHelp(
	providers: GateProvider[],
	version: string,
): string {
	const providerRows = providers
		.map((provider) =>
			formatRow(`gate ${provider.binary} <command>`, provider.name),
		)
		.join("\n");

	return `gate ${version} — multi-account switcher + universal native passthrough

USAGE
  gate <provider> auth <verb>       gate account management
  gate <provider> <deploy verb>     sandboxed deploy with account selection
  gate <provider> <anything else>   passes through to the native CLI with the
                                    selected account's credentials injected

PROVIDERS
${providerRows}

Run \`gate <provider> --help\` for the full per-provider surface.
`;
}

export function renderProviderHelp(
	provider: GateProvider,
	registry: CommandRegistry,
): string {
	const authRows = [...registry.authVerbs.entries()]
		.map(([verb, spec]) =>
			formatRow(
				`gate ${provider.binary} auth ${verb} ${spec.usage}`.trimEnd(),
				spec.description,
			),
		)
		.join("\n");

	return `gate ${provider.binary} — ${provider.name} accounts, deploys, and passthrough

ACCOUNTS
${authRows}

DEPLOY
${formatRow(`gate ${provider.binary} ${provider.deployVerb} [args...]`, registry.deploySpec.description)}
  Flags: --account <label> · --no-sandbox · --git-metadata · --create-project

PASSTHROUGH
  Any other command passes through to the native \`${provider.binary}\` CLI with
  the selected account's credentials injected:
${formatRow(`gate ${provider.binary} <native args...>`, "run any native command")}
${formatRow(`gate ${provider.binary} --account <label> ...`, "pick the account for one run")}
${formatRow(`gate ${provider.binary} -- <native args...>`, "escape hatch: verbatim native args")}
`;
}

export function renderAuthHelp(
	provider: GateProvider,
	registry: CommandRegistry,
): string {
	const rows = [...registry.authVerbs.entries()]
		.map(([verb, spec]) =>
			formatRow(`${verb} ${spec.usage}`.trimEnd(), spec.description),
		)
		.join("\n");

	return `gate ${provider.binary} auth — ${provider.name} account management

${rows}
`;
}

export function renderAuthVerbHelp(
	provider: GateProvider,
	verb: GateAuthVerb,
	spec: CommandSpec,
): string {
	return `gate ${provider.binary} auth ${verb} ${spec.usage}

${spec.description}
`;
}
