import type { GateProvider, ProviderSession } from "../providers/provider";
import type { AccountStore } from "./store";

export enum NativeSessionStatus {
	/** No native session. */
	NONE = "NONE",
	/** Native token matches a stored account. */
	MATCHES_STORED = "MATCHES_STORED",
	/** Identity already stored, token differs — stay quiet. */
	TOKEN_VARIANT = "TOKEN_VARIANT",
	/** Valid session gate doesn't know — the only offer case. */
	UNKNOWN_IDENTITY = "UNKNOWN_IDENTITY",
	/** User declined this identity before. */
	DECLINED = "DECLINED",
	/** Dead token or network failure — stay quiet. */
	INVALID = "INVALID",
}

export interface NativeSessionDiscovery {
	status: NativeSessionStatus;
	/** Present unless NONE. */
	session?: ProviderSession;
	/** Present for TOKEN_VARIANT, UNKNOWN_IDENTITY, DECLINED. */
	identity?: string;
}

/**
 * Classifies the native CLI's current session against gate's store. Pure and
 * never throws: any network or token failure is INVALID. Cost model: the two
 * common cases (no session, token matches a stored account) are decided
 * locally with zero network calls; only a foreign token costs a validate and
 * an identity lookup.
 */
export async function classifyNativeSession(
	provider: GateProvider,
	store: AccountStore,
): Promise<NativeSessionDiscovery> {
	const native = provider.readNativeSession();

	if (!native) {
		return { status: NativeSessionStatus.NONE };
	}

	const accounts = store.list(provider.id);

	if (accounts.some((account) => account.session.token === native.token)) {
		return { status: NativeSessionStatus.MATCHES_STORED, session: native };
	}

	let valid: boolean;

	try {
		valid = await provider.validate(native.token);
	} catch {
		valid = false;
	}

	if (!valid) {
		return { status: NativeSessionStatus.INVALID, session: native };
	}

	let identity: string;

	try {
		identity = await provider.identity(native.token);
	} catch {
		return { status: NativeSessionStatus.INVALID, session: native };
	}

	if (accounts.some((account) => account.identity === identity)) {
		return {
			status: NativeSessionStatus.TOKEN_VARIANT,
			session: native,
			identity,
		};
	}

	if (store.isIdentityDeclined(provider.id, identity)) {
		return {
			status: NativeSessionStatus.DECLINED,
			session: native,
			identity,
		};
	}

	return {
		status: NativeSessionStatus.UNKNOWN_IDENTITY,
		session: native,
		identity,
	};
}
