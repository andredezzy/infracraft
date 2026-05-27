import * as path from "node:path";
import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";
import { hashDirectory } from "../hash.js";

/** Configuration for a Vercel project deploy via `vercel deploy` CLI. */
export interface VercelDeployArgs {
	/** Vercel API bearer token. */
	token: pulumi.Input<string>;

	/** Vercel project ID (Output from `vercel.Project`). */
	projectId: pulumi.Input<string>;

	/** Relative path from monorepo root to the app directory (e.g. `"apps/nexus"`). */
	rootDirectory: string;

	/** Absolute path to the monorepo root (working directory for `vercel deploy`). */
	monorepoRoot: string;

	/** Vercel team/org ID. */
	teamId: string;

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
 * new VercelDeploy("vercel-deploy-nexus", {
 *   token: vercelConfig.token,
 *   projectId: project.id,
 *   rootDirectory: "apps/nexus",
 *   monorepoRoot,
 *   teamId: vercelConfig.teamId,
 *   env: { NEXT_PUBLIC_API_URL: meshUrl },
 * });
 * ```
 */
export class VercelDeploy extends pulumi.ComponentResource {
	/**
	 * @param name Pulumi resource name (logical identifier in state)
	 * @param args Deploy configuration
	 * @param opts Component resource options
	 */
	constructor(
		name: string,
		args: VercelDeployArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super("infrakit:vercel:Deploy", name, {}, opts);

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
					VERCEL_TOKEN: args.token,
					VERCEL_ORG_ID: args.teamId,
					VERCEL_PROJECT_ID: args.projectId,
				},
			},
			{ parent: this, ...(commandOpts.dependsOn ? { dependsOn: commandOpts.dependsOn } : {}) },
		);

		this.registerOutputs({});
	}
}
