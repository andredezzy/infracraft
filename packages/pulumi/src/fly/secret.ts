import * as pulumi from "@pulumi/pulumi";

import { resolveCredential } from "../dynamic/resolve-credential";
import { ApiNotFoundError } from "../errors/api-not-found-error";
import type { FlyApp } from "./app";
import { FlyClient } from "./client";
import type { FlyProvider } from "./provider";

/** Resolved inputs for the Fly secret dynamic provider. */
interface FlySecretInputs {
	/** Fly API token. Absent when `tokenEnvVar` is used instead. */
	token?: string;

	/** Env var name resolved to the token when `token` is absent (see `FlyProviderArgs.tokenEnvVar`). */
	tokenEnvVar?: string;

	/** App name the secrets belong to. */
	appName: string;

	/** Secret key/value pairs to set on the app. */
	secrets: Record<string, string>;
}

/** Persisted state for Fly secrets. */
interface FlySecretOutputs extends FlySecretInputs {
	/** Fly secrets version (uint64, stored as string). Changes on every mutation. */
	version: string;
}

/** Response shape of the bulk secrets endpoint. */
interface UpdateSecretsResponse {
	version: number;
}

/**
 * POSTs a `values` map to `/v1/apps/{app}/secrets`. Keys with `null` values are
 * deleted; keys with string values are set. Returns the new version as a string.
 */
async function applySecrets(
	client: FlyClient,
	appName: string,
	values: Record<string, string | null>,
): Promise<string> {
	const response = await client.post<UpdateSecretsResponse>(
		`/v1/apps/${appName}/secrets`,
		{ values },
	);

	return String(response.version);
}

/**
 * Dynamic provider for Fly app secrets via the Machines REST bulk endpoint.
 *
 * Secret values are stored in state (required to diff them) and wrapped with
 * `pulumi.secret()` by the public resource so they are encrypted at rest.
 * Setting secrets only takes effect on the next machine restart — wire
 * `FlySecret.version` into `FlyDeploy.triggers` to force a redeploy on change.
 *
 * @internal Exported only for unit testing; not part of the public API surface.
 */
export class FlySecretResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
	async create(inputs: FlySecretInputs): Promise<pulumi.dynamic.CreateResult> {
		const client = new FlyClient(
			resolveCredential(inputs.token, inputs.tokenEnvVar),
		);

		const version = await applySecrets(client, inputs.appName, inputs.secrets);

		const outs: FlySecretOutputs = { ...inputs, version };

		return { id: `${inputs.appName}-secrets`, outs };
	}

	async read(
		id: string,
		props: FlySecretOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		// Values are write-only (the API returns digests, not plaintext), so we
		// keep the desired state as the source of truth on refresh.
		return { id, props };
	}

	async update(
		_id: string,
		olds: FlySecretOutputs,
		news: FlySecretInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		const client = new FlyClient(
			resolveCredential(news.token, news.tokenEnvVar),
		);

		const values: Record<string, string | null> = { ...news.secrets };

		for (const key of Object.keys(olds.secrets)) {
			if (!(key in news.secrets)) {
				values[key] = null;
			}
		}

		const version = await applySecrets(client, news.appName, values);

		return { outs: { ...news, version } };
	}

	async delete(_id: string, props: FlySecretOutputs): Promise<void> {
		const client = new FlyClient(
			resolveCredential(props.token, props.tokenEnvVar),
		);

		const values: Record<string, string | null> = {};

		for (const key of Object.keys(props.secrets)) {
			values[key] = null;
		}

		try {
			await applySecrets(client, props.appName, values);
		} catch (error) {
			// App (and its secrets) already gone — deletion is idempotent.
			if (error instanceof ApiNotFoundError) {
				pulumi.log.warn(
					`Fly app "${props.appName}" already deleted — nothing to unset`,
				);

				return;
			}

			throw error;
		}
	}

	async diff(
		_id: string,
		olds: FlySecretOutputs,
		news: FlySecretInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.appName !== news.appName) {
			replaces.push("appName");
		}

		const oldKeys = Object.keys(olds.secrets).sort().join(",");
		const newKeys = Object.keys(news.secrets).sort().join(",");

		const valuesChanged = Object.entries(news.secrets).some(
			([key, value]) => olds.secrets[key] !== value,
		);

		return {
			changes: replaces.length > 0 || oldKeys !== newKeys || valuesChanged,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/** Internal dynamic resource — not part of the public API. */
class FlySecretResource extends pulumi.dynamic.Resource {
	public declare readonly version: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			token?: pulumi.Input<string>;
			tokenEnvVar?: pulumi.Input<string>;
			appName: pulumi.Input<string>;
			secrets: pulumi.Input<Record<string, string>>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new FlySecretResourceProvider(),
			name,
			{ ...args, version: undefined },
			// The API token AND the secret values themselves flow into dynamic-provider
			// state with the outputs — mark both secret there.
			{ ...opts, additionalSecretOutputs: ["token", "secrets"] },
		);
	}
}

/** Options type for FlySecret. */
type FlySecretOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Fly authentication context. */
	provider: FlyProvider;

	/** App the secrets belong to. */
	app: FlyApp;
};

/** Args for FlySecret. */
export interface FlySecretArgs {
	/**
	 * Secret key/value pairs to set on the app.
	 * Maps to the bulk secrets endpoint's `values` map (where a `null` value deletes a key).
	 */
	secrets: pulumi.Input<Record<string, string>>;
}

/**
 * Manages an app's Fly secrets as a single resource.
 *
 * Exposes `.version`, which changes only when the secret set changes — feed it
 * into `FlyDeploy.triggers` so a redeploy fires when secrets change.
 *
 * @example
 * ```typescript
 * const secrets = new FlySecret("api-secrets", {
 *   secrets: { JWT_SECRET: jwt, DATABASE_URL: dbUrl },
 * }, { provider, app });
 * ```
 */
export class FlySecret extends pulumi.ComponentResource {
	/** Fly secrets version. Changes only when the secret set changes. */
	public readonly version: pulumi.Output<string>;

	constructor(name: string, args: FlySecretArgs, opts: FlySecretOptions) {
		const { provider, app, ...pulumiOpts } = opts;

		super("infracraft:fly:Secret", name, {}, pulumiOpts);

		const resource = new FlySecretResource(
			`${name}-resource`,
			{
				token: provider.token,
				tokenEnvVar: provider.tokenEnvVar,
				appName: app.id,
				secrets: pulumi.secret(args.secrets),
			},
			// Forward the consumer's resource options (e.g. `retainOnDelete`) to the
			// underlying resource — Pulumi auto-inherits provider/protect from the
			// parent component, but not everything else.
			pulumi.mergeOptions(pulumiOpts, { parent: this }),
		);

		this.version = resource.version;

		this.registerOutputs({ version: this.version });
	}
}
