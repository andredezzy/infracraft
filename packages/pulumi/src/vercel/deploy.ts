import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";
import { stableDir } from "../stable-dir";
import type { VercelProject } from "./project";
import type { VercelProvider } from "./provider";

/** Options type for VercelDeploy — replaces Pulumi's native `provider` field. */
type VercelDeployOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Vercel authentication context. */
	provider: VercelProvider;

	/**
	 * VercelProject resource to source the project ID from.
	 * When provided, `args.projectId` is optional and ignored if both are given.
	 */
	project?: VercelProject;
};

/** Args for VercelDeploy. */
export interface VercelDeployArgs {
	/**
	 * Vercel project ID.
	 * Required when `opts.project` is not provided.
	 */
	projectId?: pulumi.Input<string>;

	/**
	 * Absolute path to the monorepo root (working directory for `vercel deploy`).
	 * Stored relative to the Pulumi program directory so the command stays stable
	 * across machines and CI (see {@link stableDir}).
	 */
	monorepoRoot: string;

	/** Values that trigger a redeploy when changed (e.g. source hashes, env hashes). */
	triggers: pulumi.Input<pulumi.Input<string>[]>;
}

/**
 * Deploys a Vercel project via `vercel deploy --prod --yes` CLI.
 *
 * Triggers on source hash (computed from the app directory) and env content hash
 * (from `VercelVariable.contentHash`). When an env value changes — whether from
 * code, a new mesh URL, or a drift fix after `pulumi refresh` — the hash changes
 * and a redeploy is triggered.
 *
 * @example
 * ```typescript
 * new VercelDeploy("nexus-deploy", {
 *   projectId: vercelProject.id,
 *   rootDirectory: "apps/nexus",
 *   monorepoRoot,
 *   env: { NEXT_PUBLIC_API_URL: meshUrl },
 * }, { provider });
 * ```
 */
export class VercelDeploy extends pulumi.ComponentResource {
	/**
	 * The production deployment URL printed by `vercel deploy` (its final stdout line).
	 * Surfaces the deployed link in stack outputs after `pulumi up` without visiting the dashboard.
	 */
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

		const deployCmd = new command.local.Command(
			`${name}-deploy`,
			{
				create: "vercel deploy --prod --yes",
				triggers: args.triggers,
				dir: stableDir(args.monorepoRoot),
				environment: {
					VERCEL_TOKEN: provider.token,
					VERCEL_ORG_ID: provider.teamId,
					VERCEL_PROJECT_ID: projectId,
				},
			},
			{ parent: this },
		);

		this.deploymentUrl = deployCmd.stdout.apply(
			(out) => out.trim().split("\n").pop() ?? "",
		);

		this.registerOutputs({ deploymentUrl: this.deploymentUrl });
	}
}
