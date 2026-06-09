// src/vercel/__tests__/deploy.test.ts  (replace entire file)
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
			stdout = {
				apply: (fn: (out: string) => string) =>
					fn("build\nhttps://nexus.vercel.app"),
			};
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

vi.mock("@pulumi/pulumi", () => {
	// Two-level mock: output(v).apply(fn) keeps the Output shell (so commandArgs.create has .apply);
	// output(v).apply(fn).apply(fn2) resolves to fn2(fn(v)) so tests can unwrap with .apply(s => s).
	const output = (v: unknown) => ({
		apply: (fn: (x: unknown) => unknown) => ({
			apply: (fn2: (x: unknown) => unknown) => fn2(fn(v)),
		}),
	});

	return {
		output,
		runtime: { isDryRun: () => false },
		getStack: () => "staging",
		ComponentResource: class {
			constructor(
				public type: string,
				public name: string,
			) {}
			registerOutputs(): void {}
		},
	};
});

import { DeploySandbox } from "../../sandbox";
import { VercelDeploy } from "../deploy";
import type { VercelProvider } from "../provider";

const provider = {
	token: "vercel-token",
	teamId: "team_abc",
} as unknown as VercelProvider;

const sandbox = new DeploySandbox("deploy-sandbox");

beforeEach(() => {
	commandCalls.length = 0;
});

describe("VercelDeploy", () => {
	it("throws when neither projectId nor project is provided", () => {
		expect(
			() =>
				new VercelDeploy(
					"nexus",
					{ triggers: [] },
					{ provider, dependsOn: [sandbox] },
				),
		).toThrow(/projectId.*project/i);
	});

	it("wires the seam with the Vercel cli and env, no monorepoRoot/dir", () => {
		new VercelDeploy(
			"nexus",
			{ projectId: "prj_1", triggers: ["h"] },
			{ provider, dependsOn: [sandbox] },
		);

		expect(commandCalls).toHaveLength(1);
		const { name, args } = commandCalls[0];
		expect(name).toBe("nexus");
		expect(args.dir).toBeUndefined();

		expect(args.environment).toEqual({
			VERCEL_TOKEN: "vercel-token",
			VERCEL_ORG_ID: "team_abc",
			VERCEL_PROJECT_ID: "prj_1",
		});

		const create = (
			args.create as { apply: (f: (s: string) => string) => string }
		).apply((s) => s);

		expect(create).toContain("vercel deploy --prod --yes");
	});

	it("derives deploymentUrl from the final stdout line", () => {
		const deploy = new VercelDeploy(
			"nexus",
			{ projectId: "prj_1", triggers: [] },
			{ provider, dependsOn: [sandbox] },
		);

		expect(deploy.deploymentUrl).toBe("https://nexus.vercel.app");
	});
});
