import * as pulumi from "@pulumi/pulumi";

/** Args for FlyProvider. */
export interface FlyProviderArgs {
	/** Fly API token (e.g. from `fly tokens create deploy`). */
	token: pulumi.Input<string>;

	/**
	 * Default Fly organization slug used when creating new apps.
	 * Can be overridden per-app via `FlyAppArgs.organization`.
	 */
	organization?: pulumi.Input<string>;
}

/**
 * Holds Fly authentication context. Passed to every Fly resource via the
 * `provider` field of its options object.
 *
 * @example
 * ```typescript
 * const provider = new FlyProvider("fly", {
 *   token: config.requireSecret("flyToken"),
 *   organization: "personal",
 * });
 * ```
 */
export class FlyProvider extends pulumi.ComponentResource {
	/** Fly API token (secret). */
	public readonly token: pulumi.Output<string>;

	/** Default organization slug for app creation, or `undefined`. */
	public readonly organization: pulumi.Output<string | undefined>;

	constructor(
		name: string,
		args: FlyProviderArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super("infracraft:fly:Provider", name, {}, opts);

		this.token = pulumi.secret(pulumi.output(args.token));
		this.organization = pulumi.output(args.organization);

		this.registerOutputs({
			token: this.token,
			organization: this.organization,
		});
	}
}
