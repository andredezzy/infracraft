import * as pulumi from "@pulumi/pulumi";

import { resolveCredential } from "../dynamic/resolve-credential";
import { Client } from "./client";
import type { Provider } from "./provider";

/** Resolved inputs for the Fly app dynamic provider. */
interface AppInputs {
	/** Fly API token. Absent when `tokenEnvVar` is used instead. */
	token?: string;

	/** Env var name resolved to the token when `token` is absent (see `ProviderArgs.tokenEnvVar`). */
	tokenEnvVar?: string;

	/** App name (globally unique). Used as the resource identifier. */
	name: string;

	/** Org slug used only when creating a new app. */
	organization?: string;
}

/** Persisted state for the Fly app. */
interface AppOutputs extends AppInputs {
	/** App identifier — equals the app name (all child paths key off the name). */
	appId: string;
}

/** Get-app response (only the fields we read). */
interface AppResponse {
	id: string;
	name: string;
}

/**
 * Dynamic provider implementing adopt-or-create for Fly apps.
 *
 * `create()` does `GET /v1/apps/{name}`; if found it adopts, otherwise it
 * `POST /v1/apps`. `delete()` is a no-op — deleting a Fly app destroys
 * everything in it, so (like Railway/Neon/Vercel top-level resources) Pulumi
 * does not delete apps.
 *
 * @internal Exported only for unit testing; not part of the public API surface.
 */
export class AppResourceProvider implements pulumi.dynamic.ResourceProvider {
	async create(inputs: AppInputs): Promise<pulumi.dynamic.CreateResult> {
		const client = new Client(
			resolveCredential(inputs.token, inputs.tokenEnvVar),
		);

		const existing = await client.tryGet<AppResponse>(
			`/v1/apps/${inputs.name}`,
		);

		if (existing) {
			pulumi.log.info(`Adopting existing Fly app "${inputs.name}"`);
		} else {
			if (!inputs.organization) {
				throw new Error(
					`fly.App "${inputs.name}": an organization is required to create a new app — set it on fly.Provider or fly.App args`,
				);
			}

			pulumi.log.info(`Fly app "${inputs.name}" not found — creating...`);

			await client.post("/v1/apps", {
				app_name: inputs.name,
				org_slug: inputs.organization,
			});
		}

		const outs: AppOutputs = { ...inputs, appId: inputs.name };

		return { id: inputs.name, outs };
	}

	async read(
		id: string,
		props: AppOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new Client(
			resolveCredential(props.token, props.tokenEnvVar),
		);

		const app = await client.tryGet<AppResponse>(`/v1/apps/${id}`);

		if (!app) {
			// Resource gone → blank id lets refresh reconcile the deletion.
			return {};
		}

		return { id, props: { ...props, name: app.name, appId: app.name } };
	}

	async delete(): Promise<void> {
		pulumi.log.warn(
			"Fly app deletion skipped — apps are not deleted by Pulumi (would destroy all contained resources)",
		);
	}

	async diff(
		_id: string,
		olds: AppOutputs,
		news: AppInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.name !== news.name) {
			replaces.push("name");
		}

		// organization is evaluated only at creation time (see AppArgs.organization)
		// and is deliberately NOT compared here: forcing a replace would destroy and
		// recreate the entire app — everything it contains — just because the config
		// value changed, even though create() never re-applies it to an adopted app.
		return {
			changes: replaces.length > 0,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/** Internal dynamic resource — not part of the public API. */
class AppResource extends pulumi.dynamic.Resource {
	public declare readonly appId: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			token?: pulumi.Input<string>;
			tokenEnvVar?: pulumi.Input<string>;
			name: pulumi.Input<string>;
			organization?: pulumi.Input<string | undefined>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new AppResourceProvider(),
			name,
			{ ...args, appId: undefined },
			// The API token flows into dynamic-provider state with the outputs — mark it secret there.
			{ ...opts, additionalSecretOutputs: ["token"] },
		);
	}
}

/** Options type for App — replaces Pulumi's native `provider` field. */
type AppOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Fly authentication context. */
	provider: Provider;
};

/** Args for App. */
export interface AppArgs {
	/**
	 * App name (globally unique). Used for adoption lookup and as `.id`.
	 * Maps to the Fly Machines API field `app_name`.
	 */
	name: pulumi.Input<string>;

	/**
	 * Org slug for app creation. Overrides `Provider.organization`.
	 * Evaluated only at creation time — changing `organization` after the app
	 * exists has no effect (an existing app is never moved between orgs; Fly
	 * only supports that via `fly apps move`/the dashboard, not this provider's
	 * REST API surface). Maps to the Fly Machines API field `org_slug`.
	 */
	organization?: pulumi.Input<string>;
}

/**
 * Manages a Fly app with adopt-or-create semantics.
 *
 * @example
 * ```typescript
 * const app = new fly.App("api", { name: "rby-api" }, { provider });
 * ```
 */
export class App extends pulumi.ComponentResource {
	/** App identifier (equals the app name). */
	public readonly id: pulumi.Output<string>;

	constructor(name: string, args: AppArgs, opts: AppOptions) {
		const { provider, ...pulumiOpts } = opts;

		super("infracraft:fly:App", name, {}, pulumiOpts);

		const resource = new AppResource(
			`${name}-resource`,
			{
				token: provider.token,
				tokenEnvVar: provider.tokenEnvVar,
				name: args.name,
				organization: args.organization ?? provider.organization,
			},
			// Forward the consumer's resource options (e.g. `retainOnDelete`) to the
			// underlying resource — Pulumi auto-inherits provider/protect from the
			// parent component, but not everything else.
			pulumi.mergeOptions(pulumiOpts, { parent: this }),
		);

		this.id = resource.appId;

		this.registerOutputs({ id: this.id });
	}
}
