import type { AccountStore } from "../accounts/store";
import type { GateProvider } from "../providers/provider";

export enum InteractionMode {
	INTERACTIVE = "INTERACTIVE",
	NON_INTERACTIVE = "NON_INTERACTIVE",
}

/** Resolved ONCE at the dispatch boundary and threaded everywhere — nothing
 * below dispatch re-reads process TTY state for behavior. */
export interface CommandContext {
	provider: GateProvider;
	store: AccountStore;
	interaction: InteractionMode;
}

/** One gate-owned verb. The registry map key IS the verb — no redundant field. */
export interface CommandSpec {
	description: string;
	/** Usage tail rendered in help, e.g. "[label]" or "[gate flags] [native args...]". */
	usage: string;
	run(context: CommandContext, args: string[]): Promise<void>;
}
