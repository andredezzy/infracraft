import * as pulumi from "@pulumi/pulumi";
import { resolveCredential } from "../dynamic/resolve-credential";
import { Client } from "./client";
import type { Provider } from "./provider";

/** Resolved inputs for the Vercel marketplace resource dynamic provider. */
interface MarketplaceResourceInputs {
	/** Vercel API bearer token. Absent when `tokenEnvVar` is used instead. */
	token?: string;

	/** Env var name resolved to the token when `token` is absent (see `ProviderArgs.tokenEnvVar`). */
	tokenEnvVar?: string;

	/** Vercel team/org ID. */
	teamId: string;

	/** Integration configuration ID (e.g. `"icfg_…"`). */
	integrationConfigurationId: string;

	/** Display name for the store. */
	name: string;

	/** Integration product ID or slug (e.g. `"upstash-kv"`). */
	type: string;

	/** Stable idempotency key for the store. */
	externalId: string;

	/** Optional metadata key/value pairs for the store. */
	metadata?: Record<string, string | number | boolean>;

	/** Optional billing plan ID. Omit to auto-select the free plan. */
	billingPlanId?: string;
}

/** Persisted state for the Vercel marketplace resource. */
interface MarketplaceResourceOutputs extends MarketplaceResourceInputs {
	/** Vercel-assigned store ID. */
	storeId: string;

	/** External resource ID assigned by the integration provider. */
	externalResourceId: string;

	/** Current provisioning status of the store. */
	status: string;
}

/** Vercel API response shape for a provisioned store. */
interface StoreResponse {
	store: {
		id: string;
		externalResourceId: string;
		status: string;
	};
}

/**
 * Dynamic provider that provisions a Vercel marketplace store via the
 * integration/direct endpoint.
 *
 * @internal Exported only for unit testing; not part of the public API surface.
 */
export class MarketplaceResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
	async create(
		inputs: MarketplaceResourceInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		const body = {
			name: inputs.name,
			integrationConfigurationId: inputs.integrationConfigurationId,
			integrationProductIdOrSlug: inputs.type,
			externalId: inputs.externalId,
			source: "cli",
			...(inputs.metadata !== undefined ? { metadata: inputs.metadata } : {}),
			...(inputs.billingPlanId !== undefined
				? { billingPlanId: inputs.billingPlanId }
				: {}),
		};

		const client = new Client(
			resolveCredential(inputs.token, inputs.tokenEnvVar),
			inputs.teamId,
		);

		const { store } = await client.post<StoreResponse>(
			"/v1/storage/stores/integration/direct",
			body,
		);

		// externalId is the idempotency key; Pulumi state normally prevents re-create. If a
		// store with this externalId already exists out-of-band (created outside Pulumi) and
		// Vercel does not dedupe server-side, this creates a duplicate — unlike the other
		// adopt-or-create providers in this package, there is no adopt-by-list lookup here.
		const outs: MarketplaceResourceOutputs = {
			...inputs,
			storeId: store.id,
			externalResourceId: store.externalResourceId,
			status: store.status,
		};

		return { id: store.id, outs };
	}

	/**
	 * Updates `metadata` in place via Vercel's Update Resource endpoint
	 * (`PATCH /v1/installations/{integrationConfigurationId}/resources/{resourceId}`).
	 * Identity fields (name, teamId, integrationConfigurationId, type, externalId)
	 * never reach here — `diff()` replaces the resource for those instead.
	 */
	async update(
		id: string,
		olds: MarketplaceResourceOutputs,
		news: MarketplaceResourceInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		const client = new Client(
			resolveCredential(news.token, news.tokenEnvVar),
			news.teamId,
		);

		await client.patch(
			`/v1/installations/${news.integrationConfigurationId}/resources/${id}`,
			{ metadata: news.metadata ?? {} },
		);

		const outs: MarketplaceResourceOutputs = {
			...olds,
			...news,
			storeId: id,
		};

		return { outs };
	}

	async read(
		id: string,
		props: MarketplaceResourceOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		// Pass-through read: Vercel's store-read endpoint isn't wired up here, so
		// out-of-band store changes are not detected — this returns stored state as-is.
		return { id, props };
	}

	async delete(): Promise<void> {
		pulumi.log.warn(
			"vercel.MarketplaceResource deletion skipped — data store; remove it from the Vercel dashboard if intended",
		);
	}

	async diff(
		_id: string,
		olds: MarketplaceResourceOutputs,
		news: MarketplaceResourceInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.name !== news.name) {
			replaces.push("name");
		}

		if (olds.teamId !== news.teamId) {
			replaces.push("teamId");
		}

		if (olds.integrationConfigurationId !== news.integrationConfigurationId) {
			replaces.push("integrationConfigurationId");
		}

		if (olds.type !== news.type) {
			replaces.push("type");
		}

		if (olds.externalId !== news.externalId) {
			replaces.push("externalId");
		}

		// metadata is updatable in place via the Update Resource endpoint (see
		// update()); billingPlanId is NOT — that endpoint only accepts a full
		// billingPlan object (id + type + name + ...), a materially different
		// shape than the plain string this provider exposes, so billingPlanId
		// stays create-time-only (see its JSDoc on MarketplaceResourceArgs).
		const metadataChanged =
			JSON.stringify(olds.metadata) !== JSON.stringify(news.metadata);

		return {
			changes: replaces.length > 0 || metadataChanged,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/** Internal dynamic resource — not part of the public API. */
class MarketplaceStoreResource extends pulumi.dynamic.Resource {
	public declare readonly storeId: pulumi.Output<string>;
	public declare readonly externalResourceId: pulumi.Output<string>;
	public declare readonly status: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			token?: pulumi.Input<string>;
			tokenEnvVar?: pulumi.Input<string>;
			teamId: pulumi.Input<string>;
			integrationConfigurationId: pulumi.Input<string>;
			name: pulumi.Input<string>;
			type: pulumi.Input<string>;
			externalId: pulumi.Input<string>;
			metadata?: pulumi.Input<Record<string, string | number | boolean>>;
			billingPlanId?: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new MarketplaceResourceProvider(),
			name,
			{
				...args,
				storeId: undefined,
				externalResourceId: undefined,
				status: undefined,
			},
			// The API token flows into dynamic-provider state with the outputs — mark it secret there.
			{ ...opts, additionalSecretOutputs: ["token"] },
		);
	}
}

/** Options type for MarketplaceResource — replaces Pulumi's native `provider` field. */
type MarketplaceResourceOptions = Omit<
	pulumi.ComponentResourceOptions,
	"provider"
> & {
	/** Vercel authentication context. */
	provider: Provider;
};

/**
 * Args for {@link MarketplaceResource}.
 */
export interface MarketplaceResourceArgs {
	/**
	 * Integration configuration ID (e.g. `"icfg_…"`).
	 * Obtain this from {@link Integration.configurationId}.
	 * Replaces on change.
	 */
	integrationConfigurationId: pulumi.Input<string>;

	/** Display name for the store. Replaces on change. */
	name: pulumi.Input<string>;

	/**
	 * Integration product ID or slug (e.g. `"upstash-kv"`, `"neon-postgres"`).
	 * Replaces on change — use the integration's canonical product slug.
	 * Maps to the request body field `integrationProductIdOrSlug`.
	 */
	type: pulumi.Input<string>;

	/**
	 * Stable idempotency key for the store.
	 * Set this to the resource name to make provisioning idempotent within
	 * a single team. Replaces on change.
	 */
	externalId: pulumi.Input<string>;

	/** Optional metadata key/value pairs forwarded to the integration provider. */
	metadata?: pulumi.Input<Record<string, string | number | boolean>>;

	/**
	 * Optional billing plan ID. Omit to auto-select the free plan for the
	 * integration product.
	 *
	 * Create-time only: Vercel's Update Resource endpoint
	 * (`PATCH /v1/installations/{id}/resources/{id}`) requires a full
	 * `billingPlan` object (`id` + `type` + `name` + ...), a materially
	 * different shape than the plain string ID accepted at creation — so
	 * this provider does not attempt to apply plan changes in place.
	 * Changing this value after creation has no effect.
	 */
	billingPlanId?: pulumi.Input<string>;
}

/**
 * Provisions a Vercel marketplace store for an installed integration.
 *
 * Calls `POST /v1/storage/stores/integration/direct` to create the store and
 * exposes the Vercel-assigned store ID and the integration provider's external
 * resource ID. Deletion is a no-op to protect data stores — remove manually
 * from the Vercel dashboard if needed.
 *
 * @example
 * ```typescript
 * const upstash = new vercel.Integration("upstash", { slug: "upstash" }, { provider });
 *
 * const kvStore = new vercel.MarketplaceResource("humanes-kv", {
 *   integrationConfigurationId: upstash.configurationId,
 *   name: "rby-humanes-kv",
 *   type: "upstash-kv",
 *   externalId: "rby-humanes-kv",
 * }, { provider });
 *
 * export const kvStoreId = kvStore.id;
 * export const kvExternalResourceId = kvStore.externalResourceId;
 * ```
 */
export class MarketplaceResource extends pulumi.ComponentResource {
	/** Vercel-assigned store ID (also the Pulumi resource ID). */
	public readonly id: pulumi.Output<string>;

	/** External resource ID assigned by the integration provider. */
	public readonly externalResourceId: pulumi.Output<string>;

	/** Current provisioning status of the store. */
	public readonly status: pulumi.Output<string>;

	constructor(
		name: string,
		args: MarketplaceResourceArgs,
		opts: MarketplaceResourceOptions,
	) {
		const { provider, ...pulumiOpts } = opts;

		super("infracraft:vercel:MarketplaceResource", name, {}, pulumiOpts);

		const resource = new MarketplaceStoreResource(
			`${name}-resource`,
			{
				token: provider.token,
				tokenEnvVar: provider.tokenEnvVar,
				teamId: provider.teamId,
				...args,
			},
			// Forward the consumer's resource options (e.g. `retainOnDelete`) to the
			// underlying resource — Pulumi auto-inherits provider/protect from the
			// parent component, but not everything else.
			pulumi.mergeOptions(pulumiOpts, { parent: this }),
		);

		this.id = resource.storeId;
		this.externalResourceId = resource.externalResourceId;
		this.status = resource.status;

		this.registerOutputs({
			id: this.id,
			externalResourceId: this.externalResourceId,
			status: this.status,
		});
	}
}
