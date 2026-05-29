import * as pulumi from "@pulumi/pulumi";

/** Args for RailwayProvider. */
export interface RailwayProviderArgs {
	/** Railway API bearer token. */
	token: pulumi.Input<string>;
}

/**
 * Holds Railway authentication context for resource constructors.
 *
 * Pass a `RailwayProvider` instance via the `provider` option on Railway resources
 * instead of passing `token` everywhere explicitly.
 *
 * @example
 * ```typescript
 * const provider = new RailwayProvider("railway", {
 *   token: config.requireSecret("railwayToken"),
 * });
 *
 * const project = new RailwayProject("my-project", { name: "my-app" }, { provider });
 * ```
 */
export class RailwayProvider extends pulumi.ComponentResource {
	/** Railway API bearer token (secret). */
	public readonly token: pulumi.Output<string>;

	constructor(
		name: string,
		args: RailwayProviderArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super("infracraft:railway:Provider", name, {}, opts);

		this.token = pulumi.secret(pulumi.output(args.token));

		this.registerOutputs({ token: this.token });
	}
}
