import * as pulumi from "@pulumi/pulumi";
import { ensurePulumiVersionMatch } from "../preflight/assert-pulumi-version-match";

/**
 * Args for FlyProvider. Exactly one of `token` and `tokenEnvVar` must be set.
 *
 * Neither `token` nor `tokenEnvVar` is ever compared in any Fly resource's
 * `diff()` — rotating the credential (or switching between the two forms)
 * never triggers a replace or an in-place update on its own; it only changes
 * which credential the next operation authenticates with.
 */
export interface FlyProviderArgs {
	/**
	 * Fly API token (e.g. from `fly tokens create deploy`).
	 * Mutually exclusive with `tokenEnvVar`.
	 */
	token?: pulumi.Input<string>;

	/**
	 * Name of the environment variable holding the Fly API token. Mutually
	 * exclusive with `token`, and the recommended form: resources carry only
	 * the plain variable name, so the credential never enters dynamic-resource
	 * inputs or per-resource state — which removes the substrate for
	 * pulumi/pulumi#16041 ("Unexpected struct type": secret Outputs in
	 * dynamic-provider inputs intermittently fail engine serialization).
	 * Dynamic-provider operations execute in the Pulumi CLI's plugin process,
	 * which inherits the program's environment, so ESC-provided
	 * `environmentVariables` reach them.
	 */
	tokenEnvVar?: pulumi.Input<string>;

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
 *   tokenEnvVar: "FLY_API_TOKEN",
 *   // or: token: config.requireSecret("flyToken"),
 *   organization: "personal",
 * });
 * ```
 */
export class FlyProvider extends pulumi.ComponentResource {
	/** Fly API token (secret). Set only when configured via `token`. */
	public readonly token?: pulumi.Output<string>;

	/** Name of the env var holding the token (plain). Set only when configured via `tokenEnvVar`. */
	public readonly tokenEnvVar?: pulumi.Output<string>;

	/** Default organization slug for app creation, or `undefined`. */
	public readonly organization: pulumi.Output<string | undefined>;

	constructor(
		name: string,
		args: FlyProviderArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super("infracraft:fly:Provider", name, {}, opts);

		ensurePulumiVersionMatch();

		if ((args.token === undefined) === (args.tokenEnvVar === undefined)) {
			throw new Error(
				"FlyProvider requires exactly one of `token` or `tokenEnvVar`",
			);
		}

		if (args.token !== undefined) {
			this.token = pulumi.secret(pulumi.output(args.token));
		}

		if (args.tokenEnvVar !== undefined) {
			this.tokenEnvVar = pulumi.output(args.tokenEnvVar);
		}

		this.organization = pulumi.output(args.organization);

		this.registerOutputs({
			token: this.token,
			tokenEnvVar: this.tokenEnvVar,
			organization: this.organization,
		});
	}
}
