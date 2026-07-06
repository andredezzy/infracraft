import * as pulumi from "@pulumi/pulumi";

/**
 * Args for NeonProvider. Exactly one of `apiKey` and `apiKeyEnvVar` must be set.
 *
 * Neither `apiKey` nor `apiKeyEnvVar` is ever compared in any Neon resource's
 * `diff()` — rotating the credential (or switching between the two forms)
 * never triggers a replace or an in-place update on its own; it only changes
 * which credential the next operation authenticates with.
 */
export interface NeonProviderArgs {
	/** Neon API key. Mutually exclusive with `apiKeyEnvVar`. */
	apiKey?: pulumi.Input<string>;

	/**
	 * Name of the environment variable holding the Neon API key. Mutually
	 * exclusive with `apiKey`, and the recommended form: resources carry only
	 * the plain variable name, so the credential never enters dynamic-resource
	 * inputs or per-resource state — which removes the substrate for
	 * pulumi/pulumi#16041 ("Unexpected struct type": secret Outputs in
	 * dynamic-provider inputs intermittently fail engine serialization).
	 * Dynamic-provider operations execute in the Pulumi CLI's plugin process,
	 * which inherits the program's environment, so ESC-provided
	 * `environmentVariables` reach them.
	 */
	apiKeyEnvVar?: pulumi.Input<string>;

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
 *   apiKeyEnvVar: "NEON_API_KEY",
 *   // or: apiKey: config.requireSecret("neonApiKey"),
 *   orgId: "org-xxx",
 * });
 *
 * const project = new NeonProject("db", { name: "my-app" }, { provider });
 * ```
 */
export class NeonProvider extends pulumi.ComponentResource {
	/** Neon API key (secret). Set only when configured via `apiKey`. */
	public readonly apiKey?: pulumi.Output<string>;

	/** Name of the env var holding the API key (plain). Set only when configured via `apiKeyEnvVar`. */
	public readonly apiKeyEnvVar?: pulumi.Output<string>;

	/** Optional Neon organization ID to scope resource lookups. */
	public readonly orgId?: pulumi.Output<string>;

	constructor(
		name: string,
		args: NeonProviderArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super("infracraft:neon:Provider", name, {}, opts);

		if ((args.apiKey === undefined) === (args.apiKeyEnvVar === undefined)) {
			throw new Error(
				"NeonProvider requires exactly one of `apiKey` or `apiKeyEnvVar`",
			);
		}

		if (args.apiKey !== undefined) {
			this.apiKey = pulumi.secret(pulumi.output(args.apiKey));
		}

		if (args.apiKeyEnvVar !== undefined) {
			this.apiKeyEnvVar = pulumi.output(args.apiKeyEnvVar);
		}

		if (args.orgId) {
			this.orgId = pulumi.output(args.orgId);
		}

		this.registerOutputs({
			apiKey: this.apiKey,
			apiKeyEnvVar: this.apiKeyEnvVar,
		});
	}
}
