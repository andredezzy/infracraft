// src/fly/deploy.ts  (replace entire file)
import * as pulumi from "@pulumi/pulumi";

import { createDeployCommand, dependsOnList } from "../commands/deploy";
import type { FlyApp } from "./app";
import type { FlyProvider } from "./provider";
import { type FlyTomlConfig, generateFlyToml } from "./toml";

type FlyDeployOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	provider: FlyProvider;
	app: FlyApp;
};

export interface FlyDeployArgs {
	/** fly.toml configuration. `config.app` must equal the FlyApp name. */
	config: FlyTomlConfig;
	/** Redeploy triggers; the generated toml content is appended automatically. */
	triggers: pulumi.Input<pulumi.Input<string>[]>;
	/** `fly deploy --wait-timeout` seconds (default 300). */
	waitTimeout?: number;
	/** `fly deploy --release-command-timeout` seconds (default 600). */
	releaseCommandTimeout?: number;
	/** `fly deploy --ha` (default false). */
	highAvailability?: boolean;
}

/**
 * Deploys a Fly app via `fly deploy --remote-only` from a generated fly.toml.
 * Isolation/git are the seam's job (list a `DeploySandbox`, optionally a `GitGuard`).
 *
 * Recommended preflight: `assertHostBinaries(["fly"])` (from
 * `@infracraft/pulumi/sandbox`) at program start, so a missing CLI fails fast
 * with an install hint instead of mid-deploy.
 */
export class FlyDeploy extends pulumi.ComponentResource {
	/** The deploy CLI's final stdout line (the Fly app URL when emitted). */
	public readonly deploymentUrl: pulumi.Output<string>;

	constructor(name: string, args: FlyDeployArgs, opts: FlyDeployOptions) {
		const { provider, app, ...pulumiOpts } = opts;

		super("infracraft:fly:Deploy", name, {}, pulumiOpts);

		const tomlContent = generateFlyToml(args.config);
		const configPath = `.fly/${args.config.app}.toml`;

		const waitTimeout = args.waitTimeout ?? 300;
		const releaseCommandTimeout = args.releaseCommandTimeout ?? 600;
		const highAvailability = args.highAvailability ?? false;

		// The toml content arrives via FLY_TOML_CONTENT (avoids shell escaping).
		const setup = `mkdir -p .fly && printf '%s' "$FLY_TOML_CONTENT" > ${configPath}`;
		const cli = `fly deploy --config ${configPath} --remote-only --ha=${highAvailability} --wait-timeout ${waitTimeout} --release-command-timeout ${releaseCommandTimeout}`;

		const triggers = pulumi
			.output(args.triggers)
			.apply((values) => [...values, tomlContent]);

		// Keep the `app` ordering anchor first; append the consumer's deps
		// (DeploySandbox / GitGuard) using the seam's shared normaliser.
		const consumerDeps = dependsOnList(pulumiOpts) as pulumi.Resource[];

		const { deploymentUrl } = createDeployCommand(
			{
				name,
				cli,
				triggers,
				setup,
				environment: {
					FLY_API_TOKEN: provider.token,
					FLY_TOML_CONTENT: tomlContent,
				},
			},
			{ ...pulumiOpts, parent: this, dependsOn: [app, ...consumerDeps] },
		);

		this.deploymentUrl = deploymentUrl;

		this.registerOutputs({ deploymentUrl: this.deploymentUrl });
	}
}
