// src/vercel/deploy.ts  (replace entire file)
import * as pulumi from "@pulumi/pulumi";

import { createDeployCommand } from "../commands/deploy";
import type { VercelProject } from "./project";
import type { VercelProvider } from "./provider";

type VercelDeployOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Vercel authentication context. */
	provider: VercelProvider;
	/** VercelProject to source the project ID from (optional if `args.projectId` given). */
	project?: VercelProject;
};

export interface VercelDeployArgs {
	/** Vercel project ID. Required when `opts.project` is not provided. */
	projectId?: pulumi.Input<string>;
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
 * @example
 * ```typescript
 * new VercelDeploy("nexus", { projectId: project.id, triggers: [sourceHash, envHash], excludePaths: ["apps/mesh"] },
 *   { provider, dependsOn: [sandbox, gitGuard] });
 * ```
 */
export class VercelDeploy extends pulumi.ComponentResource {
	public readonly deploymentUrl: pulumi.Output<string>;

	constructor(name: string, args: VercelDeployArgs, opts: VercelDeployOptions) {
		const { provider, project, ...pulumiOpts } = opts;

		super("infracraft:vercel:Deploy", name, {}, pulumiOpts);

		const projectId = project
			? project.id
			: (args.projectId as pulumi.Input<string>);

		if (!projectId) {
			throw new Error(
				"VercelDeploy: either `args.projectId` or `opts.project` must be provided",
			);
		}

		const { deploymentUrl } = createDeployCommand(
			{
				name,
				cli: "vercel deploy --prod --yes",
				triggers: args.triggers,
				excludePaths: args.excludePaths,
				environment: {
					VERCEL_TOKEN: provider.token,
					VERCEL_ORG_ID: provider.teamId,
					VERCEL_PROJECT_ID: projectId,
				},
			},
			{ parent: this, ...pulumiOpts },
		);

		this.deploymentUrl = deploymentUrl;

		this.registerOutputs({ deploymentUrl: this.deploymentUrl });
	}
}
