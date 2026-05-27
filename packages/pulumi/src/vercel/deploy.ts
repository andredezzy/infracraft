import * as path from "node:path";
import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";
import { hashDirectory } from "../hash.js";
import type { VercelProject } from "./project.js";
import type { VercelProvider } from "./provider.js";

/** Options type for VercelDeploy — replaces Pulumi's native `provider` field. */
type VercelDeployOptions = Omit<
	pulumi.ComponentResourceOptions,
	"provider"
> & {
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

	/** Relative path from monorepo root to the app directory (e.g. `"apps/nexus"`). */
	rootDirectory: string;

	/** Absolute path to the monorepo root (working directory for `vercel deploy`). */
	monorepoRoot: string;

	/** Env var map used as deploy trigger. Hashes both keys and resolved values so value changes trigger redeploy. */
	env: Record<string, pulumi.Input<string>>;

	/** Additional directories (relative to monorepo root) to include in source hash. Changes in these trigger redeploy. */
	additionalSourceDirs?: string[];

	/** Resources that must complete before the deploy runs. */
	dependsOn?: pulumi.Resource[];
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
	constructor(
		name: string,
		args: VercelDeployArgs,
		opts: VercelDeployOptions,
	) {
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

		const appDir = path.join(args.monorepoRoot, args.rootDirectory);

		const hashParts = [hashDirectory(appDir)];

		for (const dir of args.additionalSourceDirs ?? []) {
			hashParts.push(hashDirectory(path.join(args.monorepoRoot, dir)));
		}

		const sourceHash = hashParts.join(",");

		const commandOpts: pulumi.ResourceOptions = { parent: this };

		if (args.dependsOn && args.dependsOn.length > 0) {
			commandOpts.dependsOn = args.dependsOn;
		}

		const envHash = pulumi
			.all(
				Object.entries(args.env)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([k, v]) => pulumi.output(v).apply((val) => `${k}=${val}`)),
			)
			.apply((parts) => parts.join(","));

		new command.local.Command(
			`${name}-deploy`,
			{
				create: "vercel deploy --prod --yes",
				triggers: [sourceHash, envHash],
				dir: args.monorepoRoot,
				environment: {
					VERCEL_TOKEN: provider.token,
					VERCEL_ORG_ID: provider.teamId,
					VERCEL_PROJECT_ID: projectId,
				},
			},
			{
				parent: this,
				...(commandOpts.dependsOn ? { dependsOn: commandOpts.dependsOn } : {}),
			},
		);

		this.registerOutputs({});
	}
}
