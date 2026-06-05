// src/__tests__/deploy-command.test.ts
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
				apply: (fn: (out: string) => string) => fn("build\nhttps://x.app"),
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

// Minimal pulumi: output/all/interpolate resolve synchronously to the built string.
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
		interpolate: (strings: TemplateStringsArray, ...vals: unknown[]) =>
			strings.reduce(
				(acc, s, i) => acc + s + (i < vals.length ? String(vals[i]) : ""),
				"",
			),
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

import { createDeployCommand } from "../deploy-command";
import { GitGuard } from "../git-guard";
import { DeploySandbox } from "../sandbox";

beforeEach(() => {
	commandCalls.length = 0;
});

describe("createDeployCommand", () => {
	const sandbox = new DeploySandbox("deploy-sandbox");
	const gitGuard = new GitGuard("git-guard");

	it("sandbox + gitGuard → stub-mode script", () => {
		createDeployCommand(
			{
				name: "nexus",
				cli: "vercel deploy --prod --yes",
				excludePaths: ["apps/mesh"],
				triggers: [],
			},
			{ dependsOn: [sandbox, gitGuard] },
		);
		const create = (
			commandCalls[0].args.create as {
				apply: (f: (s: string) => string) => string;
			}
		).apply((s) => s);
		expect(create).toContain("mktemp -d /tmp/infracraft/staging-nexus.");
		expect(create).toContain("git init -q && git add -A");
		expect(create).toContain("apps\\/mesh");
	});

	it("sandbox only → original-.git script", () => {
		createDeployCommand(
			{ name: "nexus", cli: "vercel deploy --prod --yes", triggers: [] },
			{ dependsOn: [sandbox] },
		);
		const create = (
			commandCalls[0].args.create as {
				apply: (f: (s: string) => string) => string;
			}
		).apply((s) => s);
		expect(create).toContain('cp -c -R "$REPO/.git"');
		expect(create).not.toContain("git init");
	});

	it("neither → raw live-tree script", () => {
		createDeployCommand(
			{ name: "nexus", cli: "vercel deploy --prod --yes", triggers: [] },
			{},
		);
		const create = (
			commandCalls[0].args.create as {
				apply: (f: (s: string) => string) => string;
			}
		).apply((s) => s);
		expect(create).not.toContain("mktemp");
		expect(create).toContain('cd "$REPO"');
	});

	it("gitGuard without sandbox throws", () => {
		expect(() =>
			createDeployCommand(
				{ name: "x", cli: "x", triggers: [] },
				{ dependsOn: [gitGuard] },
			),
		).toThrow(/GitGuard.*DeploySandbox/i);
	});

	it("derives deploymentUrl from the cli's last stdout line", () => {
		const { deploymentUrl } = createDeployCommand(
			{ name: "nexus", cli: "vercel deploy --prod --yes", triggers: [] },
			{ dependsOn: [sandbox] },
		);
		expect(deploymentUrl).toBe("https://x.app");
	});

	it("forwards dependsOn, environment, and triggers to the command", () => {
		createDeployCommand(
			{
				name: "api",
				cli: "fly deploy",
				triggers: ["h"],
				environment: { FLY_API_TOKEN: "t" },
			},
			{ dependsOn: [sandbox] },
		);
		expect(commandCalls[0].args.environment).toEqual({ FLY_API_TOKEN: "t" });
		expect(commandCalls[0].args.triggers).toEqual(["h"]);
		expect(
			(commandCalls[0].opts as { dependsOn: unknown[] }).dependsOn,
		).toEqual([sandbox]);
	});
});
