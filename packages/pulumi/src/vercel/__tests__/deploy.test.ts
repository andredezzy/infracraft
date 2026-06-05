import { beforeEach, describe, expect, it, vi } from "vitest";
import { GUARD_DIR, LEGACY_GUARD_DIRS } from "../../git-guard";
import { stableDir } from "../../stable-dir";
import {
	buildVercelDeployCommand,
	buildVercelIgnore,
	VercelDeploy,
} from "../deploy";
import type { VercelProvider } from "../provider";

// Captures every `command.local.Command` constructed by VercelDeploy so the
// resource's wiring can be asserted without a real Pulumi engine. Hoisted so the
// `vi.mock` factory below (itself hoisted) can close over it.
const { commandCalls } = vi.hoisted(() => ({
	commandCalls: [] as Array<{
		name: string;
		args: Record<string, unknown>;
		opts: unknown;
	}>,
}));

// The deploy command is a dependency anchor for these tests: its `stdout.apply`
// runs synchronously against a fixed multi-line string so `deploymentUrl` can be
// asserted, and its constructor args are recorded for the wiring assertions.
vi.mock("@pulumi/command", () => ({
	local: {
		Command: class {
			stdout: { apply: (fn: (out: string) => string) => string };

			constructor(
				public name: string,
				public args: Record<string, unknown>,
				public opts: unknown,
			) {
				commandCalls.push({ name, args, opts });

				this.stdout = {
					apply: (fn) => fn("Building…\nUploading…\nhttps://nexus.vercel.app"),
				};
			}
		},
	},
}));

// VercelDeploy only needs `ComponentResource` to extend and `registerOutputs` to
// call; `runtime` is present so the imported git-guard module loads cleanly.
vi.mock("@pulumi/pulumi", () => ({
	runtime: { isDryRun: () => false },
	ComponentResource: class {
		registerOutputs(_outputs?: unknown): void {}
	},
}));

describe("buildVercelIgnore", () => {
	it("always excludes the gitGuard guard dir (Vercel never reads .gitignore)", () => {
		expect(buildVercelIgnore().split("\n")).toContain(GUARD_DIR);
	});

	it("excludes legacy guard-dir names so a mid-rename crash still hides history", () => {
		const lines = buildVercelIgnore().split("\n");

		for (const legacy of LEGACY_GUARD_DIRS) {
			expect(lines).toContain(legacy);
		}
	});

	it("excludes its own scratch files so the generated ignore never ships", () => {
		expect(buildVercelIgnore().split("\n")).toContain(".vercelignore*");
	});

	it("lists guard patterns before consumer excludes", () => {
		const lines = buildVercelIgnore(["docs"]).split("\n");

		expect(lines.indexOf(GUARD_DIR)).toBeLessThan(lines.indexOf("docs"));
	});

	it("passes non-apps excludePaths through verbatim", () => {
		const lines = buildVercelIgnore(["docs", "*.dump"]).split("\n");

		expect(lines).toContain("docs");
		expect(lines).toContain("*.dump");
	});

	it("excludes an app's code but keeps its package.json for the workspace graph", () => {
		const body = buildVercelIgnore(["apps/mesh"]);

		expect(body).toContain("apps/mesh/**");
		expect(body).toContain("!apps/mesh/package.json");
	});

	it("applies the apps rule to every apps/ entry", () => {
		const body = buildVercelIgnore(["apps/mesh", "apps/lab"]);

		expect(body).toContain("!apps/mesh/package.json");
		expect(body).toContain("!apps/lab/package.json");
	});

	it("returns only the always-ignore patterns when excludePaths is omitted", () => {
		expect(buildVercelIgnore()).toBe(buildVercelIgnore([]));
	});
});

describe("buildVercelDeployCommand", () => {
	const cmd = buildVercelDeployCommand();

	it("acquires a mkdir lock before touching .vercelignore", () => {
		expect(cmd).toContain("while ! mkdir /tmp/.vercel-upload-lock");
	});

	it("parks a committed .vercelignore before generating one", () => {
		expect(cmd).toContain(
			"if [ -f .vercelignore ]; then mv .vercelignore .vercelignore.infracraft-bak; fi",
		);
	});

	it("writes the guard dir into the generated .vercelignore", () => {
		expect(cmd).toContain(`printf '${GUARD_DIR}`);
	});

	it("restores the parked file and releases the lock in a background timer", () => {
		expect(cmd).toMatch(/\{ sleep 8;.*\} &/);

		expect(cmd).toContain(
			"[ -f .vercelignore.infracraft-bak ] && mv .vercelignore.infracraft-bak .vercelignore",
		);

		expect(cmd).toContain("rmdir /tmp/.vercel-upload-lock");
	});

	it("runs the production deploy", () => {
		expect(cmd).toContain("vercel deploy --prod --yes");
	});

	it("reports the deploy's real exit status, captured before wait", () => {
		expect(cmd).toContain("EXIT=$?; wait; exit $EXIT");
	});

	it("encodes newlines for printf and stays a single shell line", () => {
		expect(cmd).not.toContain("\n");
		expect(cmd).toContain("\\n");
	});

	it("folds excludePaths into the generated command", () => {
		expect(buildVercelDeployCommand(["docs"])).toContain("docs");
	});
});

describe("VercelDeploy", () => {
	const provider = {
		token: "vercel-token",
		teamId: "team_abc",
	} as unknown as VercelProvider;

	beforeEach(() => {
		commandCalls.length = 0;
	});

	it("throws when neither projectId nor project is provided", () => {
		expect(
			() =>
				new VercelDeploy(
					"nexus",
					{ monorepoRoot: "/repo", triggers: [] },
					{ provider },
				),
		).toThrow(/projectId.*project/i);
	});

	it("wires the Command with the engine command, stable dir, and Vercel env", () => {
		new VercelDeploy(
			"nexus",
			{ projectId: "prj_1", monorepoRoot: "/repo", triggers: ["hash"] },
			{ provider },
		);

		expect(commandCalls).toHaveLength(1);

		const { name, args } = commandCalls[0];

		expect(name).toBe("nexus-deploy");
		expect(args.create).toBe(buildVercelDeployCommand());
		expect(args.dir).toBe(stableDir("/repo"));

		expect(args.environment).toEqual({
			VERCEL_TOKEN: "vercel-token",
			VERCEL_ORG_ID: "team_abc",
			VERCEL_PROJECT_ID: "prj_1",
		});
	});

	it("forwards excludePaths into the generated deploy command", () => {
		new VercelDeploy(
			"nexus",
			{
				projectId: "prj_1",
				monorepoRoot: "/repo",
				triggers: [],
				excludePaths: ["apps/mesh"],
			},
			{ provider },
		);

		expect(commandCalls[0].args.create).toContain("apps/mesh/**");
	});

	it("derives deploymentUrl from the final stdout line", () => {
		const deploy = new VercelDeploy(
			"nexus",
			{ projectId: "prj_1", monorepoRoot: "/repo", triggers: [] },
			{ provider },
		);

		expect(deploy.deploymentUrl).toBe("https://nexus.vercel.app");
	});
});
