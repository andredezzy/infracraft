import * as pulumi from "@pulumi/pulumi";

import { createDeployCommand, dependsOnList } from "../commands/deploy";
import { resolveCredentialOutput } from "../dynamic/resolve-credential";
import type { App } from "./app";
import type { Provider } from "./provider";
import { generateFlyToml, type TomlConfig } from "./toml";

type DeployOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	provider: Provider;
	app: App;
};

export interface DeployArgs {
	/** fly.toml configuration. `config.app` must equal the App name. */
	config: TomlConfig;
	/** Redeploy triggers; the generated toml content is appended automatically. */
	triggers: pulumi.Input<pulumi.Input<string>[]>;
	/** `fly deploy --wait-timeout` seconds (default 300). */
	waitTimeout?: number;
	/** `fly deploy --release-command-timeout` seconds (default 600). */
	releaseCommandTimeout?: number;
	/** `fly deploy --ha` (default false). */
	highAvailability?: boolean;
	/** Explicit opt-in to deploy without a `DeploySandbox` in `dependsOn`. Defaults to `false`. */
	allowUnsandboxed?: boolean;
}

/**
 * Deploys a Fly app via `fly deploy --remote-only` from a generated fly.toml.
 * Isolation/git are the seam's job (e.g. a `DeploySandbox`, optionally a `GitGuard`).
 *
 * Recommended preflight: `assertHostBinaries(["fly"])` (from
 * `@infracraft/pulumi/sandbox`) at program start, so a missing CLI fails fast
 * with an install hint instead of mid-deploy.
 */
export class Deploy extends pulumi.ComponentResource {
	/** The last http(s) URL token found in the deploy CLI's stdout (the Fly app URL when emitted). */
	public readonly deploymentUrl: pulumi.Output<string>;

	constructor(name: string, args: DeployArgs, opts: DeployOptions) {
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
				allowUnsandboxed: args.allowUnsandboxed,
				environment: {
					// Resolved at program runtime (secret) so the CLI still gets the
					// actual value when the provider is configured via tokenEnvVar —
					// without the credential ever being a dynamic-resource input.
					FLY_API_TOKEN: resolveCredentialOutput(
						provider.token,
						provider.tokenEnvVar,
					),
					FLY_TOML_CONTENT: tomlContent,
				},
			},
			{ ...pulumiOpts, parent: this, dependsOn: [app, ...consumerDeps] },
		);

		this.deploymentUrl = deploymentUrl;

		this.registerOutputs({ deploymentUrl: this.deploymentUrl });
	}
}
