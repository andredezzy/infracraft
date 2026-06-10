import pc from "picocolors";

import { detectActiveAccount, ensureValidSession } from "../accounts/session";
import { resolveAccount } from "../commands/resolve-account";
import type { CommandContext } from "../registry/command-spec";
import type { PassthroughRoute } from "../routing/route-command";
import { GateAuthVerb } from "../routing/route-command";
import type { PassthroughSpawner } from "./runner";
import { runPassthrough } from "./runner";

/** Native verbs that rewrite the provider's session behind gate's back. */
const SESSION_MUTATING_VERBS: GateAuthVerb[] = [
	GateAuthVerb.LOGIN,
	GateAuthVerb.LOGOUT,
];

/** Decorative only — keyed on stderr at its single print site (the
 * behavioral interactivity signal is CommandContext.interaction). */
function printStderrBlock(lines: string[]): void {
	if (process.stderr.isTTY !== true || lines.length === 0) {
		return;
	}

	for (const line of lines) {
		process.stderr.write(`${line}\n`);
	}

	process.stderr.write("\n");
}

/**
 * The passthrough flow: resolve account → ensure a valid session → badge →
 * spawn the native CLI with injected credentials → propagate its exit code.
 */
export async function runPassthroughCommand(
	context: CommandContext,
	route: PassthroughRoute,
	spawner?: PassthroughSpawner,
): Promise<void> {
	const { provider, store, interaction } = context;

	const account = route.accountLabel
		? await resolveAccount(provider, store, route.accountLabel, { interaction })
		: (detectActiveAccount(provider, store) ??
			(await resolveAccount(provider, store, undefined, { interaction })));

	const valid = await ensureValidSession(provider, store, account, {
		interaction,
	});

	// Called here only to surface command.notice before spawning; runPassthrough
	// calls nativeCli again internally — identical results, nativeCli is pure.
	const command = provider.nativeCli({
		token: valid.session.token,
		args: route.nativeArgs,
	});

	const stderrLines: string[] = [];

	if (route.movedVerbHint) {
		stderrLines.push(
			pc.dim(
				`tip: \`gate ${provider.binary} auth ${route.movedVerbHint}\` manages gate accounts; running the native command.`,
			),
		);

		if (SESSION_MUTATING_VERBS.includes(route.movedVerbHint)) {
			stderrLines.push(
				pc.dim(
					"this modifies the native session outside gate; gate will offer to import it on the next run.",
				),
			);
		}
	}

	if (command.notice) {
		stderrLines.push(pc.dim(command.notice));
	}

	stderrLines.push(pc.dim(`● ${valid.label} (${valid.identity})`));
	printStderrBlock(stderrLines);

	const result = await runPassthrough({
		provider,
		token: valid.session.token,
		nativeArgs: route.nativeArgs,
		spawner,
	});

	process.exitCode = result.exitCode;
}
