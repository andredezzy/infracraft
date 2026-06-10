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

const RAILWAY_GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2";

interface RailwayMeResponse {
	data?: { me?: { email?: string; name?: string } };
	errors?: { message: string }[];
}

/** `GATE_RAILWAY_CONFIG_FILE` overrides (tests); otherwise the CLI's path. */
function resolveConfigFile(): string {
	return (
		process.env.GATE_RAILWAY_CONFIG_FILE ??
		path.join(homedir(), ".railway", "config.json")
	);
}

function readConfig(): Record<string, unknown> | null {
	const raw = readTextFile(resolveConfigFile());

	if (raw === null) {
		return null;
	}

	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
}

async function queryMe(token: string): Promise<RailwayMeResponse | null> {
	try {
		const response = await fetch(RAILWAY_GRAPHQL_ENDPOINT, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ query: "query { me { email name } }" }),
		});

		if (!response.ok) {
			return null;
		}

		return (await response.json()) as RailwayMeResponse;
	} catch {
		return null;
	}
}

export const railwayProvider: GateProvider = {
	id: Provider.RAILWAY,
	name: "Railway",
	binary: "railway",
	get authFile() {
		return resolveConfigFile();
	},
	loginArgv: ["railway", "login"],
	deployVerb: "up",
	deployDefaultFlags: [],
	reservedNativeFlags: [],
	deployUrlPattern: /https:\/\/railway\.(?:app|com)\/[^\s]*/,

	login(): Promise<ProviderSession> {
		return interceptNativeLogin(railwayProvider);
	},

	readNativeSession(): ProviderSession | null {
		const config = readConfig();
		const user = config?.user as Record<string, unknown> | undefined;

		if (!user || typeof user.token !== "string") {
			return null;
		}

		return { token: user.token };
	},

	writeNativeSession(session: ProviderSession): void {
		const existing = readConfig() ?? {};
		const user = (existing.user as Record<string, unknown> | undefined) ?? {};

		const merged = {
			...existing,
			user: { ...user, token: session.token },
		};

		atomicWriteFile(resolveConfigFile(), JSON.stringify(merged, null, 2));
	},

	async validate(token: string): Promise<boolean> {
		const result = await queryMe(token);

		return Boolean(result?.data?.me) && !result?.errors?.length;
	},

	async identity(token: string): Promise<string> {
		const result = await queryMe(token);
		const me = result?.data?.me;

		if (!me?.email && !me?.name) {
			throw new Error(
				"Failed to resolve the Railway user. Token may be invalid.",
			);
		}

		return me.email ?? (me.name as string);
	},

	nativeCli(context: NativeCliContext): NativeCliCommand {
		return {
			argv: ["railway", ...context.args],
			env: { RAILWAY_API_TOKEN: context.token },
		};
	},
};
