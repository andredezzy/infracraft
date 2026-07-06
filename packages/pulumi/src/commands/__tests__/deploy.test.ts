// src/commands/__tests__/deploy.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { commandCalls, stdoutFixture } = vi.hoisted(() => ({
	commandCalls: [] as Array<{
		name: string;
		args: Record<string, unknown>;
		opts: unknown;
	}>,
	// A URL mid-stream, then trailing non-URL lines (Vercel prints pretty
	// JSON after the deployment URL) — the last line is "}", not the URL, so
	// a naive last-line grab would return the brace. Tests can override this
	// per-case to exercise other stdout shapes (e.g. a URL only ever
	// appearing quoted inside JSON).
	stdoutFixture: {
		value: 'Deploying…\nhttps://x.app\n{\n  "id": "dpl_1"\n}',
	},
}));

vi.mock("@pulumi/command", () => ({
	local: {
		Command: class {
			stdout = {
				apply: (fn: (out: string) => string) => fn(stdoutFixture.value),
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
		// Matches this file's own fake-Output shape (an object with `.apply`) so
		// dependsOnList's wrapped-Output detection is testable under the mock.
		Output: {
			isInstance: (value: unknown): boolean =>
				typeof value === "object" && value !== null && "apply" in value,
		},
	};
});

import { GitGuard } from "../../git-guard";
import { DeploySandbox } from "../../sandbox";
import { createDeployCommand, dependsOnList } from "../deploy";

beforeEach(() => {
	commandCalls.length = 0;
	stdoutFixture.value = 'Deploying…\nhttps://x.app\n{\n  "id": "dpl_1"\n}';
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

		expect(create).toContain(
			'mktemp -d "/tmp/infracraft/$PROJECT-staging-nexus.',
		);

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

	it("neither, opted in via allowUnsandboxed → raw live-tree script", () => {
		createDeployCommand(
			{
				name: "nexus",
				cli: "vercel deploy --prod --yes",
				triggers: [],
				allowUnsandboxed: true,
			},
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

	it("throws when no DeploySandbox is present and allowUnsandboxed is not set", () => {
		expect(() =>
			createDeployCommand(
				{ name: "nexus", cli: "vercel deploy --prod --yes", triggers: [] },
				{},
			),
		).toThrow(/DeploySandbox.*allowUnsandboxed/i);
	});

	it("gitGuard without sandbox throws", () => {
		expect(() =>
			createDeployCommand(
				{ name: "x", cli: "x", triggers: [] },
				{ dependsOn: [gitGuard] },
			),
		).toThrow(/GitGuard.*DeploySandbox/i);
	});

	it("extracts the deploymentUrl from stdout even when non-URL lines trail it", () => {
		const { deploymentUrl } = createDeployCommand(
			{ name: "nexus", cli: "vercel deploy --prod --yes", triggers: [] },
			{ dependsOn: [sandbox] },
		);

		// The URL is followed by pretty-printed JSON whose closing "}" is the
		// final line; the last http(s) token, not the last line, is the URL.
		expect(deploymentUrl).toBe("https://x.app");
	});

	it("extracts the deploymentUrl when it only ever appears quoted inside pretty-printed JSON", () => {
		// Real-shaped `vercel deploy --prod --yes` stdout where the deployment
		// URL is never printed as a bare line — only as a quoted field inside
		// the CLI's trailing JSON summary. Proven live: the naive `^https?://`
		// token match returned "" here, since every token touching the URL
		// carried a wrapping quote and/or trailing comma.
		stdoutFixture.value = [
			"Vercel CLI 39.1.0",
			"Retrieving project…",
			"Deploying ~/project",
			"Uploading [====================] (100%)",
			"Inspect: /team/project/8VQ3x9k [2s]",
			"{",
			'  "id": "dpl_8VQ3x9kAbCdEfGhIjKlMnOpQrSt",',
			'  "url": "https://my-app-git-main-team.vercel.app",',
			'  "readyState": "READY"',
			"}",
		].join("\n");

		const { deploymentUrl } = createDeployCommand(
			{ name: "nexus", cli: "vercel deploy --prod --yes", triggers: [] },
			{ dependsOn: [sandbox] },
		);

		expect(deploymentUrl).toBe("https://my-app-git-main-team.vercel.app");
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

describe("dependsOnList", () => {
	const sandbox = new DeploySandbox("deploy-sandbox");
	const gitGuard = new GitGuard("git-guard");

	it("returns a plain array as-is", () => {
		expect(dependsOnList({ dependsOn: [sandbox, gitGuard] })).toEqual([
			sandbox,
			gitGuard,
		]);
	});

	it("wraps a single resource in an array", () => {
		expect(dependsOnList({ dependsOn: sandbox })).toEqual([sandbox]);
	});

	it("returns an empty array when dependsOn is absent", () => {
		expect(dependsOnList({})).toEqual([]);
	});

	it("throws when dependsOn is a wrapped Output — brands cannot be detected inside one", () => {
		const wrapped = { apply: () => [sandbox] };

		expect(() => dependsOnList({ dependsOn: wrapped as never })).toThrow(
			/wrapped Output.*plain array/i,
		);
	});
});
