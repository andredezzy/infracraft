import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import * as pulumi from "@pulumi/pulumi";

import { createDeployCommand } from "../commands/deploy";
import { resolveCredentialOutput } from "../dynamic/resolve-credential";
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
	/**
	 * Env vars upserted for the project (production + preview + development)
	 * by the deploy command itself, right before `vercel deploy` runs — the
	 * the env-var mechanism for Vercel deploys. A dynamic-resource path
	 * hits a Pulumi engine-internal stateful bug on clean-slate first creates
	 * ("Unexpected struct type", strictly alternating pass/fail across
	 * identical from-zero runs, reproduced with plain-literal inputs and zero
	 * secrets), so env vars are applied inside the command flow, off the
	 * dynamic-provider marshal path entirely. A change to any variable
	 * redeploys automatically (a non-secret digest of the map joins the
	 * command triggers). Values must be known at preview (config-derived) —
	 * the same class as the token the command env already carries.
	 */
	variables?: pulumi.Input<Record<string, pulumi.Input<string>>>;
}

/**
 * Absolute path to the runnable env applier, resolved next to this module in
 * `dist`. Runs as a plain Node step of the deploy command (mirroring Railway's
 * deploy monitor bin) so env vars never touch the dynamic-provider marshal
 * path. Its logic lives in the unit-tested `env-applier` module.
 */
const APPLY_ENV_BIN = fileURLToPath(
	new URL("./bin/apply-env.mjs", import.meta.url),
);

/**
 * Deploys a Vercel project via `vercel deploy --prod --yes`. Isolation and
 * git-metadata handling are entirely the seam's job — list a `DeploySandbox`
 * (and optionally a `GitGuard`) in `opts.dependsOn` to control them.
 *
 * Pass `variables` to apply the project's env vars as part of the deploy
 * command (see `VercelDeployArgs.variables` for why this replaces
 * a dynamic env-var resource).
 *
 * Recommended preflight: `assertHostBinaries(["vercel"])` (from
 * `@infracraft/pulumi/sandbox`) at program start, so a missing CLI fails fast
 * with an install hint instead of mid-deploy.
 *
 * @example
 * ```typescript
 * new VercelDeploy("nexus", {
 *   projectId: project.id,
 *   variables: { NEXT_PUBLIC_API_URL: apiUrl },
 *   triggers: [sourceHash],
 *   excludePaths: ["apps/mesh"],
 * }, { provider, dependsOn: [sandbox, gitGuard] });
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

		const environment: Record<string, pulumi.Input<string>> = {
			// Resolved at program runtime (secret) so the CLI still gets the
			// actual value when the provider is configured via tokenEnvVar —
			// without the credential ever being a dynamic-resource input.
			VERCEL_TOKEN: resolveCredentialOutput(
				provider.token,
				provider.tokenEnvVar,
			),
			VERCEL_ORG_ID: provider.teamId,
			VERCEL_PROJECT_ID: projectId,
		};

		let cli = "vercel deploy --prod --yes";
		let triggers = args.triggers;

		if (args.variables) {
			// Sorted-key JSON so the payload — and the trigger digest below — is
			// insensitive to declaration order. Marked secret so the values are
			// masked in state and diagnostics; they reach the applier bin through
			// the command environment, never the script text.
			const variablesJson = pulumi
				.output(args.variables)
				.apply((variables) =>
					JSON.stringify(
						Object.fromEntries(
							Object.entries(variables).sort(([a], [b]) => a.localeCompare(b)),
						),
					),
				);

			environment.IC_VC_ENV_JSON = pulumi.secret(variablesJson);

			// Non-secret digest of the payload (same rationale as `hash(env)`):
			// any variable change redeploys, without carrying a secret trigger.
			const variablesDigest = pulumi.unsecret(
				variablesJson.apply((json) =>
					crypto.createHash("sha256").update(json).digest("hex"),
				),
			);

			triggers = pulumi
				.output(args.triggers)
				.apply((existing) => [...existing, variablesDigest]);

			cli = `node "${APPLY_ENV_BIN}" && ${cli}`;
		}

		const { deploymentUrl } = createDeployCommand(
			{
				name,
				cli,
				triggers,
				excludePaths: args.excludePaths,
				environment,
			},
			{ parent: this, ...pulumiOpts },
		);

		this.deploymentUrl = deploymentUrl;

		this.registerOutputs({ deploymentUrl: this.deploymentUrl });
	}
}
