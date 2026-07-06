import * as pulumi from "@pulumi/pulumi";

import { createDeployCommand } from "../commands/deploy";
import { resolveCredentialOutput } from "../dynamic/resolve-credential";
import type { VercelProvider } from "./provider";

type VercelDeployOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Vercel authentication context. */
	provider: VercelProvider;
};

export interface VercelDeployArgs {
	/**
	 * Vercel project ID to deploy. Source it from the official
	 * `@pulumiverse/vercel` provider's `vercel.Project.id`.
	 */
	projectId: pulumi.Input<string>;
	/** Redeploy triggers (e.g. source hash, env content hash). */
	triggers: pulumi.Input<pulumi.Input<string>[]>;
	/** Paths excluded from the upload when running with `DeploySandbox` + `GitGuard`. */
	excludePaths?: string[];
}

/**
 * Deploys a Vercel project via `vercel deploy --prod --yes`. Isolation and
 * git-metadata handling are entirely the seam's job — list a `DeploySandbox`
 * (and optionally a `GitGuard`) in `opts.dependsOn` to control them.
 *
 * This resource owns only the CLI deploy. Manage the project itself, its custom
 * domains, and its environment variables with the official `@pulumiverse/vercel`
 * provider (`vercel.Project`, `vercel.ProjectDomain`,
 * `vercel.ProjectEnvironmentVariables`), and pass the project's ID through
 * `args.projectId`.
 *
 * Recommended preflight: `assertHostBinaries(["vercel"])` (from
 * `@infracraft/pulumi/sandbox`) at program start, so a missing CLI fails fast
 * with an install hint instead of mid-deploy.
 *
 * @example
 * ```typescript
 * new VercelDeploy("web", {
 *   projectId: project.id,
 *   triggers: [sourceHash],
 *   excludePaths: ["apps/mesh"],
 * }, { provider, dependsOn: [sandbox, gitGuard] });
 * ```
 */
export class VercelDeploy extends pulumi.ComponentResource {
	public readonly deploymentUrl: pulumi.Output<string>;

	constructor(name: string, args: VercelDeployArgs, opts: VercelDeployOptions) {
		const { provider, ...pulumiOpts } = opts;

		super("infracraft:vercel:Deploy", name, {}, pulumiOpts);

		const environment: Record<string, pulumi.Input<string>> = {
			// Resolved at program runtime (secret) so the CLI still gets the
			// actual value when the provider is configured via tokenEnvVar —
			// without the credential ever being a dynamic-resource input.
			VERCEL_TOKEN: resolveCredentialOutput(
				provider.token,
				provider.tokenEnvVar,
			),
			VERCEL_ORG_ID: provider.teamId,
			VERCEL_PROJECT_ID: args.projectId,
		};

		const { deploymentUrl } = createDeployCommand(
			{
				name,
				cli: "vercel deploy --prod --yes",
				triggers: args.triggers,
				excludePaths: args.excludePaths,
				environment,
			},
			{ parent: this, ...pulumiOpts },
		);

		this.deploymentUrl = deploymentUrl;

		this.registerOutputs({ deploymentUrl: this.deploymentUrl });
	}
}
