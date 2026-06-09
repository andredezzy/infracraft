import { homedir } from "node:os";
import path from "node:path";

import { atomicWriteFile, readTextFile } from "./auth-file";
import { interceptNativeLogin } from "./intercept-login";
import type {
	DeployCliContext,
	GateProvider,
	NativeCliCommand,
	ProviderSession,
} from "./provider";
import { Provider } from "./provider";

/** The Vercel CLI's public OAuth client id. */
const VERCEL_OAUTH_CLIENT_ID = "cl_HYyOPBNtFMfHhaUn9L4QPfTZz6TP47bp";

interface OAuthTokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
}

interface VercelUserResponse {
	user: { username: string };
}

/** `GATE_VERCEL_AUTH_FILE` overrides (tests); otherwise the CLI's platform path. */
function resolveAuthFile(): string {
	if (process.env.GATE_VERCEL_AUTH_FILE) {
		return process.env.GATE_VERCEL_AUTH_FILE;
	}

	const cliDir =
		process.platform === "darwin"
			? path.join("Library", "Application Support", "com.vercel.cli")
			: path.join(".local", "share", "com.vercel.cli");

	return path.join(homedir(), cliDir, "auth.json");
}

function readAuthData(): Record<string, unknown> | null {
	const raw = readTextFile(resolveAuthFile());

	if (raw === null) {
		return null;
	}

	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export const vercelProvider: GateProvider = {
	id: Provider.VERCEL,
	name: "Vercel",
	binary: "vercel",
	layout: { authMount: [], deployVerb: "deploy" },
	get authFile() {
		return resolveAuthFile();
	},
	loginArgv: ["vercel", "login"],
	deployUrlPattern: /https:\/\/[^\s]+\.vercel\.app[^\s]*/,

	login(): Promise<ProviderSession> {
		return interceptNativeLogin(vercelProvider);
	},

	readNativeSession(): ProviderSession | null {
		const data = readAuthData();

		if (!data || typeof data.token !== "string") {
			return null;
		}

		return {
			token: data.token,
			refreshToken:
				typeof data.refreshToken === "string" ? data.refreshToken : undefined,
			expiresAt:
				typeof data.expiresAt === "number" ? data.expiresAt : undefined,
		};
	},

	writeNativeSession(session: ProviderSession): void {
		const existing = readAuthData() ?? {};

		const merged = {
			...existing,
			token: session.token,
			refreshToken: session.refreshToken,
			expiresAt: session.expiresAt,
		};

		atomicWriteFile(resolveAuthFile(), JSON.stringify(merged, null, 2));
	},

	async validate(token: string): Promise<boolean> {
		try {
			const response = await fetch("https://api.vercel.com/v2/user", {
				headers: { Authorization: `Bearer ${token}` },
			});

			return response.ok;
		} catch {
			return false;
		}
	},

	async refresh(session: ProviderSession): Promise<ProviderSession | null> {
		if (!session.refreshToken) {
			return null;
		}

		try {
			const discovery = await fetch(
				"https://vercel.com/.well-known/openid-configuration",
			);

			if (!discovery.ok) {
				return null;
			}

			const { token_endpoint } = (await discovery.json()) as {
				token_endpoint: string;
			};

			const response = await fetch(token_endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: VERCEL_OAUTH_CLIENT_ID,
					grant_type: "refresh_token",
					refresh_token: session.refreshToken,
				}),
			});

			if (!response.ok) {
				return null;
			}

			const data = (await response.json()) as OAuthTokenResponse;

			return {
				token: data.access_token,
				refreshToken: data.refresh_token,
				expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
			};
		} catch {
			return null;
		}
	},

	async identity(token: string): Promise<string> {
		const response = await fetch("https://api.vercel.com/v2/user", {
			headers: { Authorization: `Bearer ${token}` },
		});

		if (!response.ok) {
			throw new Error(
				"Failed to resolve the Vercel user. Token may be invalid.",
			);
		}

		const data = (await response.json()) as VercelUserResponse;

		return data.user.username;
	},

	deployCli(context: DeployCliContext): NativeCliCommand {
		return {
			argv: [
				"vercel",
				"deploy",
				"--token",
				context.token,
				"--yes",
				...context.passthroughArgs,
			],
			env: {},
		};
	},
};
