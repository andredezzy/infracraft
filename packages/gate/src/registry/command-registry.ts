import { deployCommandSpec } from "../commands/deploy";
import { importCommandSpec } from "../commands/import";
import { listCommandSpec } from "../commands/list";
import { loginCommandSpec } from "../commands/login";
import { logoutCommandSpec } from "../commands/logout";
import { switchCommandSpec } from "../commands/switch";
import { whoamiCommandSpec } from "../commands/whoami";
import { GateAuthVerb } from "../routing/route-command";
import type { CommandSpec } from "./command-spec";

export interface CommandRegistry {
	/** Insertion order derives from the GateAuthVerb enum — help renders in this order. */
	authVerbs: Map<GateAuthVerb, CommandSpec>;
	/** Matched against provider.deployVerb at dispatch (never a hardcoded "deploy"). */
	deploySpec: CommandSpec;
}

/** Exhaustive by construction — a new GateAuthVerb member without a spec here
 * is a compile error. */
const AUTH_VERB_SPECS: Record<GateAuthVerb, CommandSpec> = {
	[GateAuthVerb.LOGIN]: loginCommandSpec,
	[GateAuthVerb.LOGOUT]: logoutCommandSpec,
	[GateAuthVerb.SWITCH]: switchCommandSpec,
	[GateAuthVerb.WHOAMI]: whoamiCommandSpec,
	[GateAuthVerb.LIST]: listCommandSpec,
	[GateAuthVerb.IMPORT]: importCommandSpec,
};

export function buildRegistry(): CommandRegistry {
	const authVerbs = new Map<GateAuthVerb, CommandSpec>();

	for (const verb of Object.values(GateAuthVerb)) {
		authVerbs.set(verb, AUTH_VERB_SPECS[verb]);
	}

	return { authVerbs, deploySpec: deployCommandSpec };
}
