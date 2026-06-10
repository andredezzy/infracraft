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

enum AdoptAction {
	UPDATE = "UPDATE",
	RENAME = "RENAME",
}

/**
 * Routes a fresh session for `identity` into the store without ever creating
 * a duplicate: unknown identity → label prompt + add; known identity → update
 * the entry or rename it (the mandatory merge guarantees at most one entry).
 */
export async function adoptSession(
	provider: GateProvider,
	store: AccountStore,
	identity: string,
	session: ProviderSession,
): Promise<void> {
	const existing = store.findByIdentity(provider.id, identity)[0];

	if (!existing) {
		await promptLabelAndAdd(provider, store, identity, session);

		return;
	}

	const action = await p.select({
		message: `${identity} is already stored as "${existing.label}".`,
		options: [
			{ label: `Update ${existing.label}`, value: AdoptAction.UPDATE },
			{ label: `Rename ${existing.label}`, value: AdoptAction.RENAME },
		],
	});

	if (p.isCancel(action)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}

	if (action === AdoptAction.UPDATE) {
		store.updateSession(provider.id, existing.label, session);

		p.log.success(`Updated tokens for "${existing.label}" (${identity}).`);

		return;
	}

	const label = await p.text({
		message: "New label:",
		initialValue: existing.label,
		validate: (value) => {
			if (!value?.trim()) {
				return "Label cannot be empty";
			}

			const trimmed = value.trim();

			if (trimmed !== existing.label && store.find(provider.id, trimmed)) {
				return "An account with this label already exists";
			}
		},
	});

	if (p.isCancel(label)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}

	const newLabel = (label as string).trim();

	store.remove(provider.id, existing.label);
	store.add({ provider: provider.id, label: newLabel, identity, session });

	p.log.success(
		`Renamed "${existing.label}" to "${newLabel}" and updated tokens.`,
	);
}
