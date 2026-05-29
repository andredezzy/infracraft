import * as pulumi from "@pulumi/pulumi";

/** Args for VercelProvider. */
export interface VercelProviderArgs {
	/** Vercel API bearer token. */
	token: pulumi.Input<string>;

	/** Vercel team/org ID. */
	teamId: pulumi.Input<string>;
}

/**
 * Holds Vercel authentication context for resource constructors.
 *
 * Pass a `VercelProvider` instance via the `provider` option on Vercel resources
 * instead of passing `token` and `teamId` everywhere explicitly.
 *
 * @example
 * ```typescript
 * const provider = new VercelProvider("vercel", {
 *   token: config.requireSecret("vercelToken"),
 *   teamId: "team_xxx",
 * });
 *
 * new VercelVariable("vars", { projectId: "...", variables: {} }, { provider });
 * ```
 */
export class VercelProvider extends pulumi.ComponentResource {
	/** Vercel API bearer token (secret). */
	public readonly token: pulumi.Output<string>;

	/** Vercel team/org ID. */
	public readonly teamId: pulumi.Output<string>;

	constructor(
		name: string,
		args: VercelProviderArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super("infracraft:vercel:Provider", name, {}, opts);

		this.token = pulumi.secret(pulumi.output(args.token));
		this.teamId = pulumi.output(args.teamId);

		this.registerOutputs({ token: this.token, teamId: this.teamId });
	}
}
