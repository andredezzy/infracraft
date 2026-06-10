import * as p from "@clack/prompts";

import type { AccountStore } from "../accounts/store";
import type { GateProvider, ProviderSession } from "../providers/provider";

/** Shared "label prompt → add → success" tail used by `import` and the
 * native-session discovery offer, so the two paths cannot drift. */
export async function promptLabelAndAdd(
	provider: GateProvider,
	store: AccountStore,
	identity: string,
	session: ProviderSession,
): Promise<void> {
	const label = await p.text({
		message: "Label for this account:",
		initialValue: identity,
		validate: (value) => {
			if (!value?.trim()) {
				return "Label cannot be empty";
			}

			if (store.find(provider.id, value.trim())) {
				return "An account with this label already exists";
			}
		},
	});

	if (p.isCancel(label)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}

	store.add({
		provider: provider.id,
		label: (label as string).trim(),
		identity,
		session,
	});

	p.log.success(`Account "${(label as string).trim()}" imported.`);
}
