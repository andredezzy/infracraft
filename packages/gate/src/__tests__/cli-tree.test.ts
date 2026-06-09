import { describe, expect, it } from "vitest";

import { makeProviderNamespace } from "../cli";
import { flyProvider } from "../providers/fly";
import { railwayProvider } from "../providers/railway";
import { vercelProvider } from "../providers/vercel";

const AUTH_VERBS = ["login", "logout", "switch", "whoami", "list", "import"];

describe("makeProviderNamespace", () => {
	it("mounts vercel auth verbs at the root with `deploy`", () => {
		const namespace = makeProviderNamespace(vercelProvider);
		const verbs = Object.keys(namespace.subCommands ?? {});

		expect(verbs).toEqual(expect.arrayContaining([...AUTH_VERBS, "deploy"]));
		expect(verbs).not.toContain("auth");
		expect(verbs).not.toContain("up");
	});

	it("mounts railway auth verbs at the root with `up`", () => {
		const namespace = makeProviderNamespace(railwayProvider);
		const verbs = Object.keys(namespace.subCommands ?? {});

		expect(verbs).toEqual(expect.arrayContaining([...AUTH_VERBS, "up"]));
		expect(verbs).not.toContain("deploy");
	});

	it("nests fly auth verbs under `auth` with `deploy` at the root", () => {
		const namespace = makeProviderNamespace(flyProvider);
		const verbs = Object.keys(namespace.subCommands ?? {});

		expect(verbs).toEqual(expect.arrayContaining(["auth", "deploy"]));
		expect(verbs).not.toContain("login");

		const auth = (
			namespace.subCommands as Record<
				string,
				{ subCommands?: Record<string, unknown> }
			>
		).auth;
		expect(Object.keys(auth.subCommands ?? {})).toEqual(
			expect.arrayContaining(AUTH_VERBS),
		);
	});
});
