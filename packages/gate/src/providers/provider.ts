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

export interface ProviderCommandLayout {
	/** Where auth verbs mount inside the namespace: [] (root) or ["auth"] (Fly). */
	authMount: string[];
	/** Native deploy verb: "deploy" (Vercel, Fly) | "up" (Railway). */
	deployVerb: string;
}

export interface DeployCliContext {
	token: string;
	passthroughArgs: string[];
}

export interface NativeCliCommand {
	argv: string[];
	env: Record<string, string>;
}

/**
 * The strategy contract. One implementation per platform; everything else in
 * gate (command factories, store, deploy runner) is provider-agnostic.
 */
export interface GateProvider {
	id: Provider;
	/** Display name: "Vercel". */
	name: string;
	/** Native CLI binary: "vercel" | "railway" | "fly". */
	binary: string;
	layout: ProviderCommandLayout;
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

	validate(token: string): Promise<boolean>;
	/** Silent token refresh; only Vercel implements it. */
	refresh?(session: ProviderSession): Promise<ProviderSession | null>;
	/** Username/email for display. */
	identity(token: string): Promise<string>;

	/** Native deploy invocation with provider-specific token injection. */
	deployCli(context: DeployCliContext): NativeCliCommand;
	/** Extracts the deployment URL from streamed stdout. */
	deployUrlPattern: RegExp;
}
