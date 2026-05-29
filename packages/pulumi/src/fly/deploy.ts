import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";

import { stableDir } from "../stable-dir";
import type { FlyApp } from "./app";
import type { FlyProvider } from "./provider";
import { type FlyTomlConfig, generateFlyToml } from "./toml";

/** Options type for FlyDeploy. */
type FlyDeployOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Fly authentication context. */
	provider: FlyProvider;

	/** App to deploy into. */
	app: FlyApp;
};

/** Args for FlyDeploy. */
export interface FlyDeployArgs {
	/**
	 * Absolute path to the repo root (working directory for `fly deploy`).
	 * Stored relative to the Pulumi program directory so the command stays stable
	 * across machines and CI (see {@link stableDir}).
	 */
	monorepoRoot: string;

	/**
	 * fly.toml configuration. `config.app` must equal the FlyApp name. All values
	 * are plain (not `pulumi.Input`) — resolve Outputs before constructing this.
	 */
	config: FlyTomlConfig;

	/**
	 * Values that force a redeploy when changed (e.g. a source hash from
	 * `hashDirectory()` and `FlySecret.version`). The generated toml content is
	 * appended automatically.
	 */
	triggers: pulumi.Input<pulumi.Input<string>[]>;

	/** `fly deploy --wait-timeout` in seconds (default 300). */
	waitTimeout?: number;

	/** `fly deploy --release-command-timeout` in seconds (default 600). */
	releaseCommandTimeout?: number;

	/** `fly deploy --ha` (default false). */
	highAvailability?: boolean;
}

/**
 * Deploys a Fly app via `fly deploy --remote-only`, driven by a generated
 * fly.toml. The toml is written by the deploy command itself (at execution
 * time, not during `pulumi preview`) to `<monorepoRoot>/.fly/<app>.toml`, and
 * its content is added to the redeploy triggers (so config changes redeploy).
 *
 * @example
 * ```typescript
 * new FlyDeploy("api-deploy", {
 *   monorepoRoot,
 *   config: { app: "rby-api", primaryRegion: "iad", build: { dockerfile: "apps/api/Dockerfile" } },
 *   triggers: [hashDirectory("apps/api"), secrets.version],
 * }, { provider, app, dependsOn: [secrets] });
 * ```
 */
export class FlyDeploy extends pulumi.ComponentResource {
	constructor(name: string, args: FlyDeployArgs, opts: FlyDeployOptions) {
		const { provider, app, ...pulumiOpts } = opts;

		super("infracraft:fly:Deploy", name, {}, pulumiOpts);

		const tomlContent = generateFlyToml(args.config);
		const configPath = `.fly/${args.config.app}.toml`;

		const waitTimeout = args.waitTimeout ?? 300;
		const releaseCommandTimeout = args.releaseCommandTimeout ?? 600;
		const highAvailability = args.highAvailability ?? false;

		// The toml is written by the command at execution time. The content
		// arrives via the FLY_TOML_CONTENT env var (avoiding shell escaping) so
		// no file is touched during `pulumi preview`.
		const deployCommand = [
			"mkdir -p .fly",
			`printf '%s' "$FLY_TOML_CONTENT" > ${configPath}`,
			`fly deploy --config ${configPath} --remote-only --ha=${highAvailability} --wait-timeout ${waitTimeout} --release-command-timeout ${releaseCommandTimeout}`,
		].join(" && ");

		const triggers = pulumi
			.output(args.triggers)
			.apply((values) => [...values, tomlContent]);

		new command.local.Command(
			`${name}-deploy`,
			{
				create: deployCommand,
				triggers,
				dir: stableDir(args.monorepoRoot),
				environment: {
					FLY_API_TOKEN: provider.token,
					FLY_TOML_CONTENT: tomlContent,
				},
			},
			{ parent: this, dependsOn: [app] },
		);

		this.registerOutputs({});
	}
}
