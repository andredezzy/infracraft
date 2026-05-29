import * as pulumi from "@pulumi/pulumi";

/** Args for NeonProvider. */
export interface NeonProviderArgs {
	/** Neon API key. */
	apiKey: pulumi.Input<string>;

	/** Optional Neon organization ID to scope project search. */
	orgId?: pulumi.Input<string>;
}

/**
 * Holds Neon authentication context for resource constructors.
 *
 * Pass a `NeonProvider` instance via the `provider` option on Neon resources
 * instead of passing `apiKey` everywhere explicitly.
 *
 * @example
 * ```typescript
 * const provider = new NeonProvider("neon", {
 *   apiKey: config.requireSecret("neonApiKey"),
 *   orgId: "org-xxx",
 * });
 *
 * const project = new NeonProject("db", { name: "my-app" }, { provider });
 * ```
 */
export class NeonProvider extends pulumi.ComponentResource {
	/** Neon API key (secret). */
	public readonly apiKey: pulumi.Output<string>;

	/** Optional Neon organization ID to scope resource lookups. */
	public readonly orgId?: pulumi.Output<string>;

	constructor(
		name: string,
		args: NeonProviderArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super("infracraft:neon:Provider", name, {}, opts);

		this.apiKey = pulumi.secret(pulumi.output(args.apiKey));

		if (args.orgId) {
			this.orgId = pulumi.output(args.orgId);
		}

		this.registerOutputs({ apiKey: this.apiKey });
	}
}
