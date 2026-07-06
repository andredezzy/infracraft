import * as pulumi from "@pulumi/pulumi";
import { ensurePulumiVersionMatch } from "../preflight/assert-pulumi-version-match";

/**
 * Args for RailwayProvider. Exactly one of `token` and `tokenEnvVar` must be set.
 *
 * Neither `token` nor `tokenEnvVar` is ever compared in any Railway resource's
 * `diff()` — rotating the credential (or switching between the two forms)
 * never triggers a replace or an in-place update on its own; it only changes
 * which credential the next operation authenticates with.
 */
export interface RailwayProviderArgs {
	/** Railway API bearer token. Mutually exclusive with `tokenEnvVar`. */
	token?: pulumi.Input<string>;

	/**
	 * Name of the environment variable holding the Railway API bearer token.
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
 *   tokenEnvVar: "RAILWAY_TOKEN",
 *   // or: token: config.requireSecret("railwayToken"),
 * });
 *
 * const project = new RailwayProject("my-project", { name: "my-app" }, { provider });
 * ```
 */
export class RailwayProvider extends pulumi.ComponentResource {
	/** Railway API bearer token (secret). Set only when configured via `token`. */
	public readonly token?: pulumi.Output<string>;

	/** Name of the env var holding the token (plain). Set only when configured via `tokenEnvVar`. */
	public readonly tokenEnvVar?: pulumi.Output<string>;

	constructor(
		name: string,
		args: RailwayProviderArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super("infracraft:railway:Provider", name, {}, opts);

		ensurePulumiVersionMatch();

		if ((args.token === undefined) === (args.tokenEnvVar === undefined)) {
			throw new Error(
				"RailwayProvider requires exactly one of `token` or `tokenEnvVar`",
			);
		}

		if (args.token !== undefined) {
			this.token = pulumi.secret(pulumi.output(args.token));
		}

		if (args.tokenEnvVar !== undefined) {
			this.tokenEnvVar = pulumi.output(args.tokenEnvVar);
		}

		this.registerOutputs({ token: this.token, tokenEnvVar: this.tokenEnvVar });
	}
}
