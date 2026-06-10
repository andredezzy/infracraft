export enum Provider {
	VERCEL = "VERCEL",
	RAILWAY = "RAILWAY",
	FLY = "FLY",
}

export interface ProviderSession {
	token: string;
	/** Vercel only. */
	refreshToken?: string;
	/** Vercel only — unix seconds. */
	expiresAt?: number;
}

export interface NativeCliContext {
	token: string;
	args: string[];
}

export interface NativeCliCommand {
	argv: string[];
	env: Record<string, string>;
	/** Advisory for the command layer (stderr, TTY-only) — e.g. "user --token wins". */
	notice?: string;
}

/**
 * Lets a provider expose its deploy target ("project", "app") for the
 * missing-target preflight in the deploy command. Pure data ops — prompts
 * live in the command layer.
 */
export interface DeployTargetCapability {
	/** Display noun: "project" (Vercel, Railway) | "app" (Fly). */
	noun: string;
	/** Extracts the explicit target name from the passthrough args.
	 * `undefined` means "nothing to preflight" — deploy proceeds untouched. */
	resolveName(passthroughArgs: string[]): string | undefined;
	/** False only on a definitive 404; other HTTP failures throw so the
	 * caller can decide (network errors propagate untouched). */
	exists(token: string, name: string): Promise<boolean>;
	/** Throws on any non-ok response. */
	create(token: string, name: string): Promise<void>;
}

/**
 * The strategy contract. One implementation per platform; everything else in
 * gate (registry, routing, runners, store) is provider-agnostic.
 */
export interface GateProvider {
	// ── identity card ──────────────────────────────────────────────
	id: Provider;
	/** Display name: "Vercel". */
	name: string;
	/** Native CLI binary: "vercel" | "railway" | "fly". */
	binary: string;
	/** Native deploy verb: "deploy" (Vercel, Fly) | "up" (Railway). */
	deployVerb: string;
	/** Deploy-only argv injected after the verb: ["--yes"] (Vercel) | []. */
	deployDefaultFlags: string[];
	/** Native shorthand flags gate must never extract from native regions ("-a" on Fly). */
	reservedNativeFlags: string[];

	// ── native session IO ──────────────────────────────────────────
	/** Absolute path to the native CLI's auth file (the real-switch target). */
	authFile: string;
	/** Native login argv, e.g. ["vercel", "login"] or ["fly", "auth", "login"]. */
	loginArgv: string[];
	/** Browser login via the native CLI, intercepting its auth write. */
	login(): Promise<ProviderSession>;
	/** Read the native CLI's current session (import + active detection). */
	readNativeSession(): ProviderSession | null;
	/** THE REAL SWITCH: merge the session into the native auth file (atomic write). */
	writeNativeSession(session: ProviderSession): void;

	// ── provider API ───────────────────────────────────────────────
	validate(token: string): Promise<boolean>;
	/** Silent token refresh; only Vercel implements it. */
	refresh?(session: ProviderSession): Promise<ProviderSession | null>;
	/** Username/email for display. */
	identity(token: string): Promise<string>;

	// ── native CLI invocation ──────────────────────────────────────
	/** THE single credential-injection point for any native invocation. */
	nativeCli(context: NativeCliContext): NativeCliCommand;
	/** Extracts the deployment URL from streamed stdout. */
	deployUrlPattern: RegExp;
	/** Optional missing-target preflight ops; providers without it skip the check. */
	deployTarget?: DeployTargetCapability;
}
