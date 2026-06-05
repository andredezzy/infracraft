// src/railway/__tests__/deploy.test.ts  (create or replace)
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

vi.mock("@pulumi/pulumi", () => {
	const toStr = (v: unknown) =>
		v && typeof v === "object" && "v" in (v as object)
			? String((v as { v: unknown }).v)
			: String(v);
	return {
		output: (v: unknown) => ({
			apply: (fn: (x: unknown) => unknown) => ({
				apply: (fn2: (x: unknown) => unknown) => fn2(fn(toStr(v))),
			}),
		}),
		interpolate: (strings: TemplateStringsArray, ...vals: unknown[]) =>
			strings.reduce(
				(acc, s, i) => acc + s + (i < vals.length ? toStr(vals[i]) : ""),
				"",
			),
		runtime: { isDryRun: () => false },
		ComponentResource: class {
			constructor(
				public type: string,
				public name: string,
			) {}
			registerOutputs(): void {}
		},
	};
});

import { GitGuard } from "../../git-guard";
import { DeploySandbox } from "../../sandbox";
import { RailwayDeploy } from "../deploy";

const sandbox = new DeploySandbox("deploy-sandbox");
const gitGuard = new GitGuard("git-guard");
const ctx = {
	provider: {} as never,
	project: { id: "proj_1" } as never,
	environment: { id: "env_1" } as never,
	service: { id: "svc_1" } as never,
	projectToken: "tok_1",
};

beforeEach(() => {
	commandCalls.length = 0;
});

describe("RailwayDeploy", () => {
	it("inlines the token and appends the deploy-wait poller inside the sandbox", () => {
		new RailwayDeploy(
			"mesh",
			{ triggers: [], railpackConfig: { apt: ["libatomic1"] } },
			{ ...ctx, dependsOn: [sandbox, gitGuard] },
		);
		const create = (
			commandCalls[0].args.create as {
				apply: (f: (s: string) => string) => string;
			}
		).apply((s) => s);
		expect(create).toContain("RAILWAY_TOKEN=tok_1 railway up --ci");
		expect(create).toContain("node -e");
		expect(create).toContain("railpack.json"); // setup runs in the sandbox
		expect(create).toContain("git init -q && git add -A"); // stub mode
		expect(commandCalls[0].args.environment).toBeUndefined(); // token is inlined, not env
	});
});
