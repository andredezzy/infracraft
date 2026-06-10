import { homedir } from "node:os";
import path from "node:path";

import { atomicWriteFile, readTextFile } from "./auth-file";
import { interceptNativeLogin } from "./intercept-login";
import type {
	GateProvider,
	NativeCliCommand,
	NativeCliContext,
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

interface VercelProjectResponse {
	id: string;
	accountId: string;
}

/** GET /v9/projects/{name} — null on 404; throws on other failures. The one
 * project lookup shared by deployTarget.exists and passthroughTarget.resolveEnv. */
async function fetchVercelProject(
	token: string,
	name: string,
): Promise<VercelProjectResponse | null> {
	const response = await fetch(
		`https://api.vercel.com/v9/projects/${encodeURIComponent(name)}`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);

	if (response.status === 404) {
		return null;
	}

	if (!response.ok) {
		throw new Error(`Project lookup failed (HTTP ${response.status})`);
	}

	return (await response.json()) as VercelProjectResponse;
}

/** The explicit `--project <name>` / `--project=<name>` target, if any.
 * `--scope` defers entirely to the native CLI — team lookups are v1
 * out-of-scope, so the preflight must step aside rather than guess. */
function resolveProjectName(passthroughArgs: string[]): string | undefined {
	let name: string | undefined;

	for (let index = 0; index < passthroughArgs.length; index += 1) {
		const arg = passthroughArgs[index] as string;

		if (arg === "--scope" || arg.startsWith("--scope=")) {
			return undefined;
		}

		if (arg.startsWith("--project=")) {
			name = arg.slice("--project=".length);
		} else if (arg === "--project") {
			name = passthroughArgs[index + 1];
			index += 1;
		}
	}

	return name || undefined;
}

export const vercelProvider: GateProvider = {
	id: Provider.VERCEL,
	name: "Vercel",
	binary: "vercel",
	get authFile() {
		return resolveAuthFile();
	},
	loginArgv: ["vercel", "login"],
	deployVerb: "deploy",
	deployDefaultFlags: ["--yes"],
	reservedNativeFlags: [],
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

	nativeCli(context: NativeCliContext): NativeCliCommand {
		const separatorIndex = context.args.indexOf("--");

		const visibleArgs =
			separatorIndex === -1
				? context.args
				: context.args.slice(0, separatorIndex);

		const userSuppliedToken = visibleArgs.some(
			(arg) => arg === "--token" || arg.startsWith("--token="),
		);

		if (userSuppliedToken) {
			return {
				argv: ["vercel", ...context.args],
				env: {},
				notice: "using your --token; gate account not applied",
			};
		}

		return {
			argv: ["vercel", "--token", context.token, ...context.args],
			env: {},
		};
	},

	deployTarget: {
		noun: "project",
		resolveName: resolveProjectName,

		async exists(token: string, name: string): Promise<boolean> {
			return (await fetchVercelProject(token, name)) !== null;
		},

		async create(token: string, name: string): Promise<void> {
			const response = await fetch("https://api.vercel.com/v9/projects", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ name }),
			});

			if (!response.ok) {
				throw new Error(`Project creation failed (HTTP ${response.status})`);
			}
		},
	},

	passthroughTarget: {
		flag: "--project",
		noun: "project",

		async resolveEnv(
			token: string,
			name: string,
		): Promise<Record<string, string>> {
			const project = await fetchVercelProject(token, name);

			if (!project) {
				throw new Error(
					`Project "${name}" was not found for this account. List projects with \`gate vercel project ls\`.`,
				);
			}

			return {
				VERCEL_PROJECT_ID: project.id,
				VERCEL_ORG_ID: project.accountId,
			};
		},
	},
};
