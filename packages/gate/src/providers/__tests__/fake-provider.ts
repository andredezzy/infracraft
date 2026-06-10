import { vi } from "vitest";

import type { GateProvider, ProviderSession } from "../provider";
import { Provider } from "../provider";

/**
 * The ONE canonical GateProvider fake. Test files wrap it locally when they
 * need closures (e.g. a mutable `native` session variable).
 */
export function makeFakeProvider(
	overrides: Partial<GateProvider> = {},
): GateProvider {
	return {
		id: Provider.VERCEL,
		name: "Fake",
		binary: "fake",
		deployVerb: "deploy",
		deployDefaultFlags: [],
		reservedNativeFlags: [],
		authFile: "/dev/null",
		loginArgv: ["fake", "login"],
		deployUrlPattern: /x/,
		login: vi.fn(async (): Promise<ProviderSession> => ({ token: "fresh" })),
		readNativeSession: () => null,
		writeNativeSession: vi.fn(),
		validate: vi.fn(async () => true),
		identity: vi.fn(async () => "andre"),
		nativeCli: (context) => ({
			argv: ["fake", ...context.args],
			env: { FAKE_TOKEN: context.token },
		}),
		...overrides,
	};
}
