import * as pulumi from "@pulumi/pulumi";
import { VercelClient } from "./client";
import type { VercelProvider } from "./provider";

/** Resolved inputs for the Vercel marketplace resource dynamic provider. */
interface VercelMarketplaceResourceInputs {
	/** Vercel API bearer token. */
	token: string;

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
interface VercelMarketplaceResourceOutputs
	extends VercelMarketplaceResourceInputs {
	/** Vercel-assigned store ID. */
	storeId: string;

	/** External resource ID assigned by the integration provider. */
	externalResourceId: string;

	/** Current provisioning status of the store. */
	status: string;
}

/** Vercel API response shape for a provisioned store. */
interface VercelStoreResponse {
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
export class VercelMarketplaceResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
	async create(
		inputs: VercelMarketplaceResourceInputs,
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

		const client = new VercelClient(inputs.token, inputs.teamId);

		const { store } = await client.post<VercelStoreResponse>(
			"/v1/storage/stores/integration/direct",
			body,
		);

		// externalId is the idempotency key; Pulumi state normally prevents re-create.
		// If a store with this externalId already exists out-of-band and Vercel does not
		// dedupe, this could create a duplicate — adopt-by-list is a follow-up.
		const outs: VercelMarketplaceResourceOutputs = {
			...inputs,
			storeId: store.id,
			externalResourceId: store.externalResourceId,
			status: store.status,
		};

		return { id: store.id, outs };
	}

	async read(
		id: string,
		props: VercelMarketplaceResourceOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		// The store read endpoint was not pinned in this phase; drift is not refreshed here.
		return { id, props };
	}

	async delete(): Promise<void> {
		pulumi.log.warn(
			"VercelMarketplaceResource deletion skipped — data store; remove it from the Vercel dashboard if intended",
		);
	}

	async diff(
		_id: string,
		olds: VercelMarketplaceResourceOutputs,
		news: VercelMarketplaceResourceInputs,
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

		return {
			changes: replaces.length > 0,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/** Internal dynamic resource — not part of the public API. */
class VercelMarketplaceResourceResource extends pulumi.dynamic.Resource {
	public declare readonly storeId: pulumi.Output<string>;
	public declare readonly externalResourceId: pulumi.Output<string>;
	public declare readonly status: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			token: pulumi.Input<string>;
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
			new VercelMarketplaceResourceProvider(),
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

/** Options type for VercelMarketplaceResource — replaces Pulumi's native `provider` field. */
type VercelMarketplaceResourceOptions = Omit<
	pulumi.ComponentResourceOptions,
	"provider"
> & {
	/** Vercel authentication context. */
	provider: VercelProvider;
};

/**
 * Args for {@link VercelMarketplaceResource}.
 */
export interface VercelMarketplaceResourceArgs {
	/**
	 * Integration configuration ID (e.g. `"icfg_…"`).
	 * Obtain this from {@link VercelIntegration.configurationId}.
	 */
	integrationConfigurationId: pulumi.Input<string>;

	/** Display name for the store. */
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
 * const upstash = new VercelIntegration("upstash", { slug: "upstash" }, { provider });
 *
 * const kvStore = new VercelMarketplaceResource("humanes-kv", {
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
export class VercelMarketplaceResource extends pulumi.ComponentResource {
	/** Vercel-assigned store ID (also the Pulumi resource ID). */
	public readonly id: pulumi.Output<string>;

	/** External resource ID assigned by the integration provider. */
	public readonly externalResourceId: pulumi.Output<string>;

	/** Current provisioning status of the store. */
	public readonly status: pulumi.Output<string>;

	constructor(
		name: string,
		args: VercelMarketplaceResourceArgs,
		opts: VercelMarketplaceResourceOptions,
	) {
		const { provider, ...pulumiOpts } = opts;

		super("infracraft:vercel:MarketplaceResource", name, {}, pulumiOpts);

		const resource = new VercelMarketplaceResourceResource(
			`${name}-resource`,
			{
				token: provider.token,
				teamId: provider.teamId,
				...args,
			},
			{ parent: this },
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
