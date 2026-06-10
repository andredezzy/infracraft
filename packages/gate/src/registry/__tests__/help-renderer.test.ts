import { describe, expect, it } from "vitest";

import { makeFakeProvider } from "../../providers/__tests__/fake-provider";
import { PROVIDERS } from "../../providers/registry";
import { buildRegistry } from "../command-registry";
import {
	renderAuthHelp,
	renderProviderHelp,
	renderRootHelp,
} from "../help-renderer";

const registry = buildRegistry();

describe("renderRootHelp", () => {
	it("lists every provider and explains the passthrough", () => {
		const help = renderRootHelp(PROVIDERS, "9.9.9");

		expect(help).toContain("9.9.9");
		expect(help).toContain("vercel");
		expect(help).toContain("railway");
		expect(help).toContain("fly");
		expect(help).toContain("passes through");
	});
});

describe("renderProviderHelp", () => {
	it("documents auth, deploy, and the passthrough surface", () => {
		const provider = makeFakeProvider({ deployVerb: "up" });
		const help = renderProviderHelp(provider, registry);

		expect(help).toContain("auth login");
		expect(help).toContain("auth import");
		expect(help).toContain("gate fake up");
		expect(help).toContain("--account");
		expect(help).toContain("passes through");
		expect(help).toContain("--");
	});
});

describe("renderAuthHelp", () => {
	it("lists all six verbs with usage", () => {
		const help = renderAuthHelp(makeFakeProvider(), registry);

		for (const verb of [
			"login",
			"logout",
			"switch",
			"whoami",
			"list",
			"import",
		]) {
			expect(help).toContain(verb);
		}

		expect(help).toContain("[label]");
	});
});
