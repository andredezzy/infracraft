import type { GateProvider, ProviderSession } from "../providers/provider";
import type { AccountStore, GateAccount } from "./store";

const EXPIRY_BUFFER_SECONDS = 60;

/**
 * Active = the stored account whose token matches the native CLI's current
 * session. Derived, never stored — the native file is the single source of
 * truth, so this cannot drift.
 */
export function detectActiveAccount(
	provider: GateProvider,
	store: AccountStore,
): GateAccount | null {
	const native = provider.readNativeSession();

	if (!native) {
		return null;
	}

	return (
		store
			.list(provider.id)
			.find((account) => account.session.token === native.token) ?? null
	);
}

function isExpired(session: ProviderSession): boolean {
	if (typeof session.expiresAt !== "number") {
		return false;
	}

	return (
		session.expiresAt <= Math.floor(Date.now() / 1000) + EXPIRY_BUFFER_SECONDS
	);
}

/**
 * Returns the account with a session that is known-valid, trying the cheapest
 * path first: silent refresh on expiry → validate → silent refresh → recover
 * from the native CLI (same identity only) → browser re-login. Every new
 * session persists to the store; if the account is the active one, the native
 * auth file is updated too, so the native CLI never holds a stale token.
 */
export async function ensureValidSession(
	provider: GateProvider,
	store: AccountStore,
	account: GateAccount,
): Promise<GateAccount> {
	const wasActive =
		detectActiveAccount(provider, store)?.label === account.label;

	const adopt = (session: ProviderSession): GateAccount => {
		store.updateSession(provider.id, account.label, session);

		if (wasActive) {
			provider.writeNativeSession(session);
		}

		return { ...account, session };
	};

	if (isExpired(account.session) && provider.refresh) {
		const refreshed = await provider.refresh(account.session);

		if (refreshed) {
			return adopt(refreshed);
		}
	}

	if (await provider.validate(account.session.token)) {
		return account;
	}

	if (provider.refresh) {
		const refreshed = await provider.refresh(account.session);

		if (refreshed) {
			return adopt(refreshed);
		}
	}

	const native = provider.readNativeSession();

	if (native && (await provider.validate(native.token))) {
		const nativeIdentity = await provider.identity(native.token);

		if (nativeIdentity === account.identity) {
			return adopt(native);
		}
	}

	const fresh = await provider.login();

	return adopt(fresh);
}
