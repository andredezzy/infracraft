import type { GateProvider } from "../providers/provider";

export enum GateFlagRegion {
	/** Passthrough: a leading slot exists where reserved shorthands are also recognized. */
	WITH_LEADING_SLOT = "WITH_LEADING_SLOT",
	/** Deploy's post-verb args: the whole region is native; reserved shorthands never extracted. */
	NATIVE_REGION_ONLY = "NATIVE_REGION_ONLY",
}

export interface SplitGateFlags {
	accountLabel: string | undefined;
	nativeArgs: string[];
	/** Set when a gate flag is malformed (missing value / value is another flag). */
	malformed: string | undefined;
}

const ACCOUNT_FLAG = "--account";
const ACCOUNT_SHORTHAND = "-a";

/**
 * Extracts gate-owned account flags from a native arg stream.
 * - `--account <v>` / `--account=<v>`: anywhere, both regions.
 * - `-a <v>`: anywhere — unless the provider reserves "-a" natively, in which
 *   case only inside the leading slot (the run of gate flags before the first
 *   native token), and never in NATIVE_REGION_ONLY.
 * - Parsing stops at the first `--`; the separator and everything after it are
 *   kept verbatim (they belong to the native command).
 * - Empty-string values mean "no account given"; flag-like values are malformed.
 */
export function splitGateFlags(
	provider: GateProvider,
	rawArgs: string[],
	region: GateFlagRegion,
): SplitGateFlags {
	let accountLabel: string | undefined;
	let malformed: string | undefined;
	const nativeArgs: string[] = [];

	const shorthandReserved =
		provider.reservedNativeFlags.includes(ACCOUNT_SHORTHAND);

	let inLeadingSlot = region === GateFlagRegion.WITH_LEADING_SLOT;
	let parsing = true;

	for (let index = 0; index < rawArgs.length; index += 1) {
		const arg = rawArgs[index] as string;

		if (!parsing) {
			nativeArgs.push(arg);

			continue;
		}

		if (arg === "--") {
			parsing = false;
			nativeArgs.push(arg);

			continue;
		}

		if (arg.startsWith(`${ACCOUNT_FLAG}=`)) {
			const value = arg.slice(ACCOUNT_FLAG.length + 1);

			if (value !== "") {
				accountLabel = value;
			}

			continue;
		}

		const isShorthandHere =
			arg === ACCOUNT_SHORTHAND && (!shorthandReserved || inLeadingSlot);

		if (arg === ACCOUNT_FLAG || isShorthandHere) {
			const value = rawArgs[index + 1];

			if (value === undefined || value.startsWith("-")) {
				malformed = `${arg} requires a value.`;

				return {
					accountLabel,
					nativeArgs: [...nativeArgs, ...rawArgs.slice(index)],
					malformed,
				};
			}

			index += 1;

			if (value !== "") {
				accountLabel = value;
			}

			continue;
		}

		inLeadingSlot = false;
		nativeArgs.push(arg);
	}

	return { accountLabel, nativeArgs, malformed };
}
