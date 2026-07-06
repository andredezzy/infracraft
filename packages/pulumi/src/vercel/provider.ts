import * as pulumi from "@pulumi/pulumi";
import { ensurePulumiVersionMatch } from "../preflight/assert-pulumi-version-match";

/**
 * Args for Provider. Exactly one of `token` and `tokenEnvVar` must be set.
 *
 * Neither `token` nor `tokenEnvVar` is ever compared in any Vercel resource's
 * `diff()` — rotating the credential (or switching between the two forms)
 * never triggers a replace or an in-place update on its own; it only changes
 * which credential the next operation authenticates with.
 */
export interface ProviderArgs {
	/** Vercel API bearer token. Mutually exclusive with `tokenEnvVar`. */
	token?: pulumi.Input<string>;

	/**
	 * Name of the environment variable holding the Vercel API bearer token.
	 * Mutually exclusive with `token`, and the recommended form: resources
	 * carry only the plain variable name, so the credential never enters
	 * dynamic-resource inputs or per-resource state — which removes the
	 * substrate for pulumi/pulumi#16041 ("Unexpected struct type": secret
	 * Outputs in dynamic-provider inputs intermittently fail engine
	 * serialization). Dynamic-provider operations execute in the Pulumi CLI's
	 * plugin process, which inherits the program's environment, so
	 * ESC-provided `environmentVariables` reach them.
	 */
	tokenEnvVar?: pulumi.Input<string>;

	/** Vercel team/org ID. */
	teamId: pulumi.Input<string>;
}

/**
 * Holds Vercel authentication context for resource constructors.
 *
 * Pass a `Provider` instance via the `provider` option on Vercel resources
 * instead of passing `token` and `teamId` everywhere explicitly.
 *
 * @example
 * ```typescript
 * const provider = new vercel.Provider("vercel", {
 *   tokenEnvVar: "VERCEL_TOKEN",
 *   // or: token: config.requireSecret("vercelToken"),
 *   teamId: "team_xxx",
 * });
 *
 * new vercel.Deploy("deploy", {
 *   projectId: "...",
 *   triggers: [sourceHash],
 * }, { provider });
 * ```
 */
export class Provider extends pulumi.ComponentResource {
	/** Vercel API bearer token (secret). Set only when configured via `token`. */
	public readonly token?: pulumi.Output<string>;

	/** Name of the env var holding the token (plain). Set only when configured via `tokenEnvVar`. */
	public readonly tokenEnvVar?: pulumi.Output<string>;

	/** Vercel team/org ID. */
	public readonly teamId: pulumi.Output<string>;

	constructor(
		name: string,
		args: ProviderArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super("infracraft:vercel:Provider", name, {}, opts);

		ensurePulumiVersionMatch();

		if ((args.token === undefined) === (args.tokenEnvVar === undefined)) {
			throw new Error(
				"vercel.Provider requires exactly one of `token` or `tokenEnvVar`",
			);
		}

		if (args.token !== undefined) {
			this.token = pulumi.secret(pulumi.output(args.token));
		}

		if (args.tokenEnvVar !== undefined) {
			this.tokenEnvVar = pulumi.output(args.tokenEnvVar);
		}

		this.teamId = pulumi.output(args.teamId);

		this.registerOutputs({
			token: this.token,
			tokenEnvVar: this.tokenEnvVar,
			teamId: this.teamId,
		});
	}
}
