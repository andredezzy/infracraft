import type { GateProvider } from "../providers/provider";
import { GateFlagRegion, splitGateFlags } from "./split-gate-flags";

export enum CommandRoute {
	GATE_TREE = "GATE_TREE",
	PASSTHROUGH = "PASSTHROUGH",
	INVALID = "INVALID",
}

/** Values are the literal argv tokens. */
export enum GateAuthVerb {
	LOGIN = "login",
	LOGOUT = "logout",
	SWITCH = "switch",
	WHOAMI = "whoami",
	LIST = "list",
	IMPORT = "import",
}

export const AUTH_NAMESPACE = "auth";

export interface GateTreeRoute {
	route: CommandRoute.GATE_TREE;
	/** Normalized args for dispatch — leading account/target flags re-inject
	 * after the deploy verb (`--account <label>`, then the target flag). */
	gateArgs: string[];
}

export interface PassthroughRoute {
	route: CommandRoute.PASSTHROUGH;
	/** Native args with gate flags extracted (or the verbatim tail after a leading "--"). */
	nativeArgs: string[];
	accountLabel: string | undefined;
	/** Value of the provider's claimed target flag (e.g. --project), if given. */
	targetName: string | undefined;
	/** Set when the first native token is a moved gate verb — triggers the stderr hint. */
	movedVerbHint: GateAuthVerb | undefined;
}

export interface InvalidRoute {
	route: CommandRoute.INVALID;
	message: string;
}

export type RoutedCommand = GateTreeRoute | PassthroughRoute | InvalidRoute;

export function toGateAuthVerb(
	token: string | undefined,
): GateAuthVerb | undefined {
	return (Object.values(GateAuthVerb) as string[]).includes(token ?? "")
		? (token as GateAuthVerb)
		: undefined;
}

const SOLE_GATE_TOKENS = ["--help", "-h", "--version"];

/**
 * Pure routing — no I/O, no process state, never throws.
 *
 * Rules (mirrors the spec table):
 * 1. Empty, or a sole --help/-h/--version → GATE_TREE.
 * 2. auth + gate verb, bare auth, or auth + --help/-h → GATE_TREE; with an
 *    extracted account or target flag → INVALID (unless --help/-h rides along — then
 *    GATE_TREE so dispatch renders help).
 * 3. auth + anything else → PASSTHROUGH (native `fly auth token`).
 * 4. deployVerb → GATE_TREE; extracted account/target flags re-inject after the verb.
 * 5. A leading "--" → PASSTHROUGH, verbatim tail (gate flags BEFORE it apply).
 * 6. Anything else → PASSTHROUGH; movedVerbHint when the first token is a
 *    moved gate verb.
 * 7. A malformed gate flag → INVALID; gate flags with nothing to run → INVALID.
 */
export function routeCommand(
	provider: GateProvider,
	rawArgs: string[],
): RoutedCommand {
	if (rawArgs.length === 0) {
		return { route: CommandRoute.GATE_TREE, gateArgs: [] };
	}

	if (rawArgs.length === 1 && SOLE_GATE_TOKENS.includes(rawArgs[0] as string)) {
		return { route: CommandRoute.GATE_TREE, gateArgs: rawArgs };
	}

	const split = splitGateFlags(
		provider,
		rawArgs,
		GateFlagRegion.WITH_LEADING_SLOT,
	);

	if (split.malformed) {
		return { route: CommandRoute.INVALID, message: split.malformed };
	}

	const [first, ...rest] = split.nativeArgs;

	if (first === undefined) {
		return {
			route: CommandRoute.INVALID,
			message: `Nothing to run after the gate flags. Pass a command, e.g. \`gate ${provider.binary} ${provider.deployVerb} --account <label>\`.`,
		};
	}

	if (first === "--") {
		return {
			route: CommandRoute.PASSTHROUGH,
			nativeArgs: rest,
			accountLabel: split.accountLabel,
			targetName: split.targetName,
			movedVerbHint: undefined,
		};
	}

	if (first === AUTH_NAMESPACE) {
		const isGateAuthForm =
			rest.length === 0 ||
			toGateAuthVerb(rest[0]) !== undefined ||
			rest[0] === "--help" ||
			rest[0] === "-h";

		if (isGateAuthForm) {
			const helpRequested = rest.includes("--help") || rest.includes("-h");

			const hasGateFlags =
				split.accountLabel !== undefined || split.targetName !== undefined;

			if (hasGateFlags && !helpRequested) {
				return {
					route: CommandRoute.INVALID,
					message: `auth commands take a label argument — use \`gate ${provider.binary} auth <verb> <label>\`.`,
				};
			}

			return { route: CommandRoute.GATE_TREE, gateArgs: split.nativeArgs };
		}

		return {
			route: CommandRoute.PASSTHROUGH,
			nativeArgs: split.nativeArgs,
			accountLabel: split.accountLabel,
			targetName: split.targetName,
			movedVerbHint: undefined,
		};
	}

	if (first === provider.deployVerb) {
		const gateArgs = [...split.nativeArgs];

		if (split.accountLabel !== undefined) {
			gateArgs.push("--account", split.accountLabel);
		}

		if (split.targetName !== undefined && provider.passthroughTarget) {
			gateArgs.push(provider.passthroughTarget.flag, split.targetName);
		}

		return { route: CommandRoute.GATE_TREE, gateArgs };
	}

	return {
		route: CommandRoute.PASSTHROUGH,
		nativeArgs: split.nativeArgs,
		accountLabel: split.accountLabel,
		targetName: split.targetName,
		movedVerbHint: toGateAuthVerb(first),
	};
}
