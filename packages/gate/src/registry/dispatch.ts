import * as p from "@clack/prompts";

import packageJson from "../../package.json";
import { AccountStore } from "../accounts/store";
import { runAction } from "../commands/run-action";
import { runPassthroughCommand } from "../passthrough/command";
import { PROVIDERS } from "../providers/registry";
import {
	AUTH_NAMESPACE,
	CommandRoute,
	routeCommand,
	toGateAuthVerb,
} from "../routing/route-command";
import type { CommandRegistry } from "./command-registry";
import { buildRegistry } from "./command-registry";
import type { CommandContext } from "./command-spec";
import { InteractionMode } from "./command-spec";
import {
	renderAuthHelp,
	renderAuthVerbHelp,
	renderProviderHelp,
	renderRootHelp,
} from "./help-renderer";

export interface DispatchOptions {
	rawArgs: string[];
	store?: AccountStore;
	registry?: CommandRegistry;
}

const HELP_TOKENS = ["--help", "-h"];

/**
 * The single dispatch path (no citty):
 *   GATE_TREE    → registry lookup (auth verbs by map key, deploy by
 *                  provider.deployVerb) or help rendering
 *   PASSTHROUGH  → runPassthroughCommand
 *   INVALID      → message on the error path, exit 1
 *
 * InteractionMode is resolved HERE, once, from process.stdout.isTTY, and
 * threaded via CommandContext — nothing below re-reads TTY state for behavior.
 */
export async function dispatch(options: DispatchOptions): Promise<void> {
	const store = options.store ?? new AccountStore();
	const registry = options.registry ?? buildRegistry();

	const [providerName, ...providerArgs] = options.rawArgs;

	if (providerName === undefined || HELP_TOKENS.includes(providerName)) {
		process.stdout.write(renderRootHelp(PROVIDERS, packageJson.version));

		return;
	}

	if (providerName === "--version") {
		process.stdout.write(`${packageJson.version}\n`);

		return;
	}

	const provider = PROVIDERS.find(
		(candidate) => candidate.binary === providerName,
	);

	if (!provider) {
		p.log.error(
			`Unknown provider "${providerName}". Available: ${PROVIDERS.map((candidate) => candidate.binary).join(", ")}.`,
		);

		process.exitCode = 1;

		return;
	}

	const interaction =
		process.stdout.isTTY === true
			? InteractionMode.INTERACTIVE
			: InteractionMode.NON_INTERACTIVE;

	const context: CommandContext = { provider, store, interaction };
	const routed = routeCommand(provider, providerArgs);

	if (routed.route === CommandRoute.INVALID) {
		p.log.error(routed.message);
		process.exitCode = 1;

		return;
	}

	if (routed.route === CommandRoute.PASSTHROUGH) {
		await runAction(() => runPassthroughCommand(context, routed));

		return;
	}

	await runGateTree(context, registry, routed.gateArgs);
}

async function runGateTree(
	context: CommandContext,
	registry: CommandRegistry,
	gateArgs: string[],
): Promise<void> {
	const [first, ...rest] = gateArgs;

	if (first === undefined || HELP_TOKENS.includes(first)) {
		process.stdout.write(renderProviderHelp(context.provider, registry));

		return;
	}

	if (first === "--version") {
		process.stdout.write(`${packageJson.version}\n`);

		return;
	}

	if (first === AUTH_NAMESPACE) {
		const [verbToken, ...verbArgs] = rest;

		if (verbToken === undefined || HELP_TOKENS.includes(verbToken)) {
			process.stdout.write(renderAuthHelp(context.provider, registry));

			return;
		}

		const verb = toGateAuthVerb(verbToken);
		const spec = verb === undefined ? undefined : registry.authVerbs.get(verb);

		if (verb === undefined || !spec) {
			// Unreachable by the routing contract; defensive.
			p.log.error(`Unknown auth command "${verbToken}".`);
			process.exitCode = 1;

			return;
		}

		if (verbArgs.some((arg) => HELP_TOKENS.includes(arg))) {
			process.stdout.write(renderAuthVerbHelp(context.provider, verb, spec));

			return;
		}

		await spec.run(context, verbArgs);

		return;
	}

	if (first === context.provider.deployVerb) {
		await registry.deploySpec.run(context, rest);

		return;
	}

	// Unreachable by the routing contract; defensive.
	p.log.error(`Unknown command "${first}".`);
	process.exitCode = 1;
}
