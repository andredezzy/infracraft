// src/fly/__tests__/deploy.test.ts  (create or replace)
import { beforeEach, describe, expect, it, vi } from "vitest";

const { commandCalls } = vi.hoisted(() => ({
	commandCalls: [] as Array<{
		name: string;
		args: Record<string, unknown>;
		opts: unknown;
	}>,
}));

vi.mock("@pulumi/command", () => ({
	local: {
		Command: class {
			stdout = { apply: (fn: (out: string) => string) => fn("") };
			constructor(
				public name: string,
				public args: Record<string, unknown>,
				public opts: unknown,
			) {
				commandCalls.push({ name, args, opts });
			}
		},
	},
}));

vi.mock("@pulumi/pulumi", () => ({
	output: (v: unknown) => ({
		apply: (fn: (x: unknown) => unknown) => ({
			apply: (fn2: (x: unknown) => unknown) =>
				fn2(
					fn(typeof v === "string" ? v : ((v as { val?: unknown }).val ?? v)),
				),
		}),
	}),
	runtime: { isDryRun: () => false },
	getStack: () => "staging",
	ComponentResource: class {
		constructor(
			public type: string,
			public name: string,
		) {}
		registerOutputs(): void {}
	},
}));

import { DeploySandbox } from "../../sandbox";
import { FlyDeploy } from "../deploy";

const sandbox = new DeploySandbox("deploy-sandbox");
const ctx = {
	provider: { token: "fly-token" } as never,
	app: { name: "api" } as never,
};

beforeEach(() => {
	commandCalls.length = 0;
});

describe("FlyDeploy", () => {
	it("writes fly.toml via setup and passes the token + toml content as env", () => {
		new FlyDeploy(
			"api",
			{
				config: { app: "rby-api", primaryRegion: "iad" } as never,
				triggers: ["h"],
			},
			{ ...ctx, dependsOn: [sandbox] },
		);
		const create = (
			commandCalls[0].args.create as {
				apply: (f: (s: string) => string) => string;
			}
		).apply((s) => s);
		expect(create).toContain("mkdir -p .fly");
		expect(create).toContain(
			"fly deploy --config .fly/rby-api.toml --remote-only",
		);
		const env = commandCalls[0].args.environment as Record<string, string>;
		expect(env.FLY_API_TOKEN).toBe("fly-token");
		expect(typeof env.FLY_TOML_CONTENT).toBe("string");
	});
});
