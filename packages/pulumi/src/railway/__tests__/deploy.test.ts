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
		// all(...).apply(fn) resolves synchronously so the healthcheck bindings
		// land in the interpolated script as a plain string.
		all: (vals: unknown[]) => ({
			apply: (fn: (x: unknown[]) => unknown) => fn(vals),
		}),
		interpolate: (strings: TemplateStringsArray, ...vals: unknown[]) =>
			strings.reduce(
				(acc, s, i) => acc + s + (i < vals.length ? toStr(vals[i]) : ""),
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

import { GitGuard } from "../../git-guard";
import { DeploySandbox } from "../../sandbox";
import { Deploy } from "../deploy";

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

describe("railway.Deploy", () => {
	it("uploads with --detach and hands off to the monitor bin inside the sandbox", () => {
		new Deploy(
			"api",
			{ triggers: [], railpackConfig: { apt: ["libatomic1"] } },
			{ ...ctx, dependsOn: [sandbox, gitGuard] },
		);

		const create = (
			commandCalls[0].args.create as {
				apply: (f: (s: string) => string) => string;
			}
		).apply((s) => s);

		// Detached upload (no flaky build-log stream); JSON for the exact deployment id.
		expect(create).toContain(
			'RAILWAY_TOKEN="$IC_TOK" railway up --detach --json',
		);

		// The token travels via stdin and must NEVER appear in the script text:
		// pulumi-command embeds the executed command in its failure error, and Pulumi
		// does not scrub secrets from provider diagnostics.
		expect(create).not.toContain("tok_1");
		expect(create).toContain("IFS= read -r IC_TOK || true");
		expect(commandCalls[0].args.stdin).toBe("tok_1");
		// The CLI exit code no longer short-circuits: its output + exit are captured and
		// handed to the API-authoritative monitor bin instead of an inline `node -e` blob.
		// The capture is if/else-guarded: under `set -e`, a bare VAR=$(cmd); EXIT=$?
		// dies at the assignment on failure and swallows the CLI's error output.
		expect(create).toContain("if IC_UP_OUT=$(");
		// The else is load-bearing: `IC_UP_EXIT=$?` after `if…fi` would capture the
		// if-statement's exit (0 on a false condition), not the CLI's failure code.
		expect(create).toContain(
			"then IC_UP_EXIT=0; break; else IC_UP_EXIT=$?; fi",
		);
		expect(create).not.toContain('IC_UP_OUT=$("');
		// A transport-level upload failure ("error sending request" — no deployment
		// created) is retried, bounded + with backoff; NO other exit is retried, so a
		// flaky post-upload exit (deployment may exist) can never double-deploy.
		expect(create).toContain('IC_TRY=1; while [ "$IC_TRY" -le 3 ]');
		expect(create).toContain("IC_TRY=$((IC_TRY+1))");
		// No `seq` dependency: a missing/failed `seq` would expand empty, run zero
		// iterations, never invoke `railway up`, and falsely report success.
		expect(create).not.toContain("seq ");
		expect(create).toContain('case "$IC_UP_OUT" in *"error sending request"*)');
		expect(create).toContain('[ "$IC_TRY" -lt 3 ]');
		expect(create).toContain("sleep 5");
		expect(create).toContain("bin/monitor-deployment.mjs");
		expect(create).not.toContain("railway up --ci");
		expect(create).not.toContain("node -e '"); // poller is a real module now, not inline
		expect(create).toContain("railpack.json"); // setup runs in the sandbox
		expect(create).toContain("git init -q && git add -A"); // stub mode
		expect(commandCalls[0].args.environment).toBeUndefined(); // token is stdin, not env
		// The monitor's IC_* bindings must be wired (a rename/reorder here would otherwise
		// fail silently — the monitor can't poll without them).
		expect(create).toContain('IC_TOK="$IC_TOK"');
		expect(create).toContain("IC_PROJ=proj_1");
		expect(create).toContain("IC_ENV=env_1");
		expect(create).toContain("IC_SVC=svc_1");
		expect(create).toContain("IC_UP_EXIT=$IC_UP_EXIT");
		// IC_SINCE is captured before `railway up` and forwarded as a createdAt fallback.
		expect(create).toContain("IC_SINCE=$(node -e");
		expect(create).toContain("IC_SINCE=$IC_SINCE");
		// No healthcheck args → no IC_HC_* bindings (the monitor must skip cleanly).
		expect(create).not.toContain("IC_HC_");
	});

	it("passes IC_HC_* bindings to the monitor only when healthcheck args are provided", () => {
		new Deploy(
			"api",
			{
				triggers: [],
				healthcheckPath: "/healthcheck",
				healthcheckTimeout: 300,
			},
			{ ...ctx, dependsOn: [sandbox, gitGuard] },
		);

		const create = (
			commandCalls[0].args.create as {
				apply: (f: (s: string) => string) => string;
			}
		).apply((s) => s);

		expect(create).toContain("IC_HC_PATH='/healthcheck'");
		expect(create).toContain("IC_HC_TIMEOUT=300");
	});

	it("throws when healthcheckPath contains a hyphen (same Railway field service.ts validates)", () => {
		expect(
			() =>
				new Deploy(
					"api",
					{ triggers: [], healthcheckPath: "/health-check" },
					{ ...ctx, dependsOn: [sandbox, gitGuard] },
				),
		).toThrow(/hyphen/);
	});

	it("escapes railpackConfig values containing an apostrophe (POSIX single-quote)", () => {
		new Deploy(
			"api",
			{ triggers: [], railpackConfig: { note: "it's fine" } },
			{ ...ctx, dependsOn: [sandbox, gitGuard] },
		);

		const create = (
			commandCalls[0].args.create as {
				apply: (f: (s: string) => string) => string;
			}
		).apply((s) => s);

		// `printf '%s'` (not a bare format) + POSIX ' -> '\'' escaping.
		expect(create).toContain("printf '%s' '");
		expect(create).toContain("it'\\''s fine"); // apostrophe escaped, not broken
	});
});
