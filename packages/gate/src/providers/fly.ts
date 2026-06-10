import { homedir } from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";

import { atomicWriteFile, readTextFile } from "./auth-file";
import { interceptNativeLogin } from "./intercept-login";
import type {
	DeployCliContext,
	GateProvider,
	NativeCliCommand,
	NativeCliContext,
	ProviderSession,
} from "./provider";
import { Provider } from "./provider";

const FLY_GRAPHQL_ENDPOINT = "https://api.fly.io/graphql";

interface FlyViewerResponse {
	data?: { viewer?: { email?: string } };
	errors?: { message: string }[];
}

/** `GATE_FLY_CONFIG_FILE` overrides (tests); otherwise the CLI's path. */
function resolveConfigFile(): string {
	return (
		process.env.GATE_FLY_CONFIG_FILE ??
		path.join(homedir(), ".fly", "config.yml")
	);
}

function readConfig(): Record<string, unknown> | null {
	const raw = readTextFile(resolveConfigFile());

	if (raw === null) {
		return null;
	}

	try {
		return (parse(raw) as Record<string, unknown>) ?? null;
	} catch {
		return null;
	}
}

async function queryViewer(token: string): Promise<FlyViewerResponse | null> {
	try {
		const response = await fetch(FLY_GRAPHQL_ENDPOINT, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ query: "query { viewer { email } }" }),
		});

		if (!response.ok) {
			return null;
		}

		return (await response.json()) as FlyViewerResponse;
	} catch {
		return null;
	}
}

export const flyProvider: GateProvider = {
	id: Provider.FLY,
	name: "Fly.io",
	binary: "fly",
	layout: { authMount: ["auth"], deployVerb: "deploy" },
	get authFile() {
		return resolveConfigFile();
	},
	loginArgv: ["fly", "auth", "login"],
	deployVerb: "deploy",
	deployDefaultFlags: [],
	reservedNativeFlags: ["-a"],
	deployUrlPattern: /https?:\/\/[^\s]+\.fly\.dev[^\s]*/,

	login(): Promise<ProviderSession> {
		return interceptNativeLogin(flyProvider);
	},

	readNativeSession(): ProviderSession | null {
		const config = readConfig();

		if (!config || typeof config.access_token !== "string") {
			return null;
		}

		return { token: config.access_token };
	},

	writeNativeSession(session: ProviderSession): void {
		const existing = readConfig() ?? {};

		const merged = { ...existing, access_token: session.token };

		atomicWriteFile(resolveConfigFile(), stringify(merged));
	},

	async validate(token: string): Promise<boolean> {
		const result = await queryViewer(token);

		return Boolean(result?.data?.viewer?.email) && !result?.errors?.length;
	},

	async identity(token: string): Promise<string> {
		const result = await queryViewer(token);
		const email = result?.data?.viewer?.email;

		if (!email) {
			throw new Error(
				"Failed to resolve the Fly.io user. Token may be invalid.",
			);
		}

		return email;
	},

	nativeCli(context: NativeCliContext): NativeCliCommand {
		return {
			argv: ["fly", ...context.args],
			env: { FLY_API_TOKEN: context.token },
		};
	},

	deployCli(context: DeployCliContext): NativeCliCommand {
		return {
			argv: ["fly", "deploy", ...context.passthroughArgs],
			env: { FLY_API_TOKEN: context.token },
		};
	},
};
