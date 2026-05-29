import * as pulumi from "@pulumi/pulumi";

import { FlyClient } from "./client";
import type { FlyProvider } from "./provider";

/** Resolved inputs for the Fly app dynamic provider. */
export interface FlyAppInputs {
	/** Fly API token. */
	token: string;

	/** App name (globally unique). Used as the resource identifier. */
	name: string;

	/** Org slug used only when creating a new app. */
	organization?: string;
}

/** Persisted state for the Fly app. */
interface FlyAppOutputs extends FlyAppInputs {
	/** App identifier — equals the app name (all child paths key off the name). */
	appId: string;
}

/** Get-app response (only the fields we read). */
interface FlyAppResponse {
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
 */
class FlyAppResourceProvider implements pulumi.dynamic.ResourceProvider {
	async create(inputs: FlyAppInputs): Promise<pulumi.dynamic.CreateResult> {
		const client = new FlyClient(inputs.token);
		const existing = await client.tryGet<FlyAppResponse>(
			`/v1/apps/${inputs.name}`,
		);

		if (existing) {
			pulumi.log.info(`Adopting existing Fly app "${inputs.name}"`);
		} else {
			if (!inputs.organization) {
				throw new Error(
					`FlyApp "${inputs.name}": an organization is required to create a new app — set it on FlyProvider or FlyApp args`,
				);
			}

			pulumi.log.info(`Fly app "${inputs.name}" not found — creating...`);

			await client.post("/v1/apps", {
				app_name: inputs.name,
				org_slug: inputs.organization,
			});
		}

		const outs: FlyAppOutputs = { ...inputs, appId: inputs.name };

		return { id: inputs.name, outs };
	}

	async read(
		id: string,
		props: FlyAppOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new FlyClient(props.token);
		const app = await client.tryGet<FlyAppResponse>(`/v1/apps/${id}`);

		if (!app) {
			throw new Error(`Fly app "${id}" not found during refresh`);
		}

		return { id, props: { ...props, name: app.name, appId: app.name } };
	}

	async update(
		id: string,
		_olds: FlyAppOutputs,
		news: FlyAppInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		return { outs: { ...news, appId: id } };
	}

	async delete(): Promise<void> {
		pulumi.log.warn(
			"Fly app deletion skipped — apps are not deleted by Pulumi (would destroy all contained resources)",
		);
	}

	async diff(
		_id: string,
		olds: FlyAppOutputs,
		news: FlyAppInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.name !== news.name) {
			replaces.push("name");
		}
		if (olds.organization !== news.organization) {
			replaces.push("organization");
		}

		return {
			changes: replaces.length > 0,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/** Internal dynamic resource — not part of the public API. */
class FlyAppResource extends pulumi.dynamic.Resource {
	public declare readonly appId: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			token: pulumi.Input<string>;
			name: pulumi.Input<string>;
			organization?: pulumi.Input<string | undefined>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new FlyAppResourceProvider(),
			name,
			{ ...args, appId: undefined },
			opts,
		);
	}
}

/** Options type for FlyApp — replaces Pulumi's native `provider` field. */
type FlyAppOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Fly authentication context. */
	provider: FlyProvider;
};

/** Args for FlyApp. */
export interface FlyAppArgs {
	/** App name (globally unique). Used for adoption lookup and as `.id`. */
	name: pulumi.Input<string>;

	/**
	 * Org slug for app creation. Overrides `FlyProvider.organization`.
	 * Ignored when the app already exists (adoption).
	 */
	organization?: pulumi.Input<string>;
}

/**
 * Manages a Fly app with adopt-or-create semantics.
 *
 * @example
 * ```typescript
 * const app = new FlyApp("api", { name: "rby-api" }, { provider });
 * ```
 */
export class FlyApp extends pulumi.ComponentResource {
	/** App identifier (equals the app name). */
	public readonly id: pulumi.Output<string>;

	constructor(name: string, args: FlyAppArgs, opts: FlyAppOptions) {
		const { provider, ...pulumiOpts } = opts;

		super("infracraft:fly:App", name, {}, pulumiOpts);

		const resource = new FlyAppResource(
			`${name}-resource`,
			{
				token: provider.token,
				name: args.name,
				organization: args.organization ?? provider.organization,
			},
			{ parent: this },
		);

		this.id = resource.appId;

		this.registerOutputs({ id: this.id });
	}
}
