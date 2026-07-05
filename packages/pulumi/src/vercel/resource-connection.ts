import * as pulumi from "@pulumi/pulumi";
import { VercelClient } from "./client";
import type { VercelProvider } from "./provider";

/** Resolved inputs for the Vercel resource connection dynamic provider. */
interface VercelResourceConnectionInputs {
	/** Vercel API bearer token. */
	token: string;

	/** Vercel team/org ID. */
	teamId: string;

	/** The Vercel store ID of the provisioned marketplace resource (e.g. `"store_…"`). */
	storeId: string;

	/** The Vercel project ID to connect the store to. */
	projectId: string;

	/** Deployment environments to inject env vars into (e.g. `["production", "preview"]`). */
	targets: string[];

	/**
	 * Whether the injected env vars are marked sensitive.
	 * Vercel rejects sensitive env vars on the `development` target, so `targets`
	 * must not include `development` when this is `true`.
	 */
	makeEnvVarsSensitive: boolean;
}

/** Persisted state for the Vercel resource connection. */
type VercelResourceConnectionOutputs = VercelResourceConnectionInputs;

/** A single store-to-project connection as returned by the Vercel API. */
interface StoreConnection {
	id: string;
	projectId: string;
}

/** Vercel API response for listing a store's connections. */
interface StoreConnectionsResponse {
	connections: StoreConnection[];
}

/**
 * Finds an existing connection from a store to a specific project.
 * A 404 (store gone or not yet visible) reads as "no connection".
 */
async function findConnection(
	client: VercelClient,
	storeId: string,
	projectId: string,
): Promise<StoreConnection | undefined> {
	const data = await client.tryGet<StoreConnectionsResponse>(
		`/v1/storage/stores/${storeId}/connections`,
	);

	return data?.connections.find((c) => c.projectId === projectId);
}

/**
 * Dynamic provider that connects a Vercel marketplace store to a project,
 * injecting the store's env vars into the specified deployment environments.
 *
 * @internal Exported only for unit testing; not part of the public API surface.
 */
export class VercelResourceConnectionProvider
	implements pulumi.dynamic.ResourceProvider
{
	async create(
		inputs: VercelResourceConnectionInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		if (inputs.makeEnvVarsSensitive && inputs.targets.includes("development")) {
			throw new Error(
				"VercelResourceConnection: Vercel rejects sensitive env vars on the 'development' target. " +
					"Either drop 'development' from targets or set makeEnvVarsSensitive to false.",
			);
		}

		const client = new VercelClient(inputs.token, inputs.teamId);

		// Adopt-or-create: a store can only be connected to a given project once,
		// so re-creating an out-of-band connection (or a prior partial apply) adopts it.
		const existing = await findConnection(
			client,
			inputs.storeId,
			inputs.projectId,
		);

		if (existing) {
			pulumi.log.info(
				`Adopting existing Vercel store connection (${existing.id})`,
			);

			return {
				id: `${inputs.storeId}:${inputs.projectId}`,
				outs: { ...inputs },
			};
		}

		await client.post(`/v1/storage/stores/${inputs.storeId}/connections`, {
			projectId: inputs.projectId,
			envVarEnvironments: inputs.targets,
			makeEnvVarsSensitive: inputs.makeEnvVarsSensitive,
		});

		return {
			id: `${inputs.storeId}:${inputs.projectId}`,
			outs: { ...inputs },
		};
	}

	async read(
		id: string,
		props: VercelResourceConnectionOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		// The connection list endpoint exposes presence but not the targeted environments,
		// so env-var drift is not refreshed here — only the connection's existence.
		return { id, props };
	}

	async delete(): Promise<void> {
		pulumi.log.warn(
			"VercelResourceConnection deletion skipped — no public per-project disconnect endpoint; disconnect from the Vercel dashboard if intended",
		);
	}

	async diff(
		_id: string,
		olds: VercelResourceConnectionOutputs,
		news: VercelResourceConnectionInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.teamId !== news.teamId) {
			replaces.push("teamId");
		}

		if (olds.storeId !== news.storeId) {
			replaces.push("storeId");
		}

		if (olds.projectId !== news.projectId) {
			replaces.push("projectId");
		}

		// targets comparison is order-sensitive by design: the array is sent verbatim to the
		// API as envVarEnvironments, so reordering is a meaningful change.
		if (JSON.stringify(olds.targets) !== JSON.stringify(news.targets)) {
			replaces.push("targets");
		}

		if (olds.makeEnvVarsSensitive !== news.makeEnvVarsSensitive) {
			replaces.push("makeEnvVarsSensitive");
		}

		return {
			changes: replaces.length > 0,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/** Internal dynamic resource — not part of the public API. */
class VercelResourceConnectionResource extends pulumi.dynamic.Resource {
	constructor(
		name: string,
		args: {
			token: pulumi.Input<string>;
			teamId: pulumi.Input<string>;
			storeId: pulumi.Input<string>;
			projectId: pulumi.Input<string>;
			targets: pulumi.Input<string[]>;
			makeEnvVarsSensitive: pulumi.Input<boolean>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new VercelResourceConnectionProvider(),
			name,
			{ ...args },
			// The API token flows into dynamic-provider state with the outputs — mark it secret there.
			{ ...opts, additionalSecretOutputs: ["token"] },
		);
	}
}

/** Options type for VercelResourceConnection — replaces Pulumi's native `provider` field. */
type VercelResourceConnectionOptions = Omit<
	pulumi.ComponentResourceOptions,
	"provider"
> & {
	/** Vercel authentication context. */
	provider: VercelProvider;
};

/**
 * Args for {@link VercelResourceConnection}.
 */
export interface VercelResourceConnectionArgs {
	/**
	 * The Vercel store ID of the provisioned marketplace resource (e.g. `"store_…"`).
	 * Obtain this from {@link VercelMarketplaceResource.id}.
	 */
	storeId: pulumi.Input<string>;

	/** The Vercel project ID to connect the store to. */
	projectId: pulumi.Input<string>;

	/**
	 * Deployment environments into which the store's env vars will be injected.
	 * Typical values: `["production", "preview"]`. Note that `development`
	 * cannot be combined with `makeEnvVarsSensitive: true` (Vercel rejects it).
	 */
	targets: pulumi.Input<string[]>;

	/**
	 * Whether the injected env vars are marked sensitive (hidden after creation).
	 * Defaults to `true`. When `true`, `targets` must not include `development`.
	 */
	makeEnvVarsSensitive?: pulumi.Input<boolean>;
}

/**
 * Connects a Vercel marketplace store to a project, injecting its env vars
 * into the specified deployment environments.
 *
 * Calls `POST /v1/storage/stores/{storeId}/connections`. Uses adopt-or-create:
 * an existing connection from the store to the project is adopted rather than
 * re-created. Deletion is a no-op — there is no public per-project disconnect
 * endpoint; disconnect manually from the Vercel dashboard if needed.
 *
 * @example
 * ```typescript
 * const kvStore = new VercelMarketplaceResource("humanes-kv", {
 *   integrationConfigurationId: upstash.configurationId,
 *   name: "rby-humanes-kv",
 *   type: "upstash-kv",
 *   externalId: "rby-humanes-kv",
 * }, { provider });
 *
 * new VercelResourceConnection("humanes-kv-conn", {
 *   storeId: kvStore.id,
 *   projectId: humanesProject.id,
 *   targets: ["production", "preview"],
 * }, { provider });
 * ```
 */
export class VercelResourceConnection extends pulumi.ComponentResource {
	constructor(
		name: string,
		args: VercelResourceConnectionArgs,
		opts: VercelResourceConnectionOptions,
	) {
		const { provider, ...pulumiOpts } = opts;

		super("infracraft:vercel:ResourceConnection", name, {}, pulumiOpts);

		new VercelResourceConnectionResource(
			`${name}-resource`,
			{
				token: provider.token,
				teamId: provider.teamId,
				storeId: args.storeId,
				projectId: args.projectId,
				targets: args.targets,
				makeEnvVarsSensitive: args.makeEnvVarsSensitive ?? true,
			},
			{ parent: this },
		);

		this.registerOutputs({});
	}
}
