import * as pulumi from "@pulumi/pulumi";
import type { VercelProvider } from "./provider";

const VERCEL_API_URL = "https://api.vercel.com";

/** Resolved inputs for the Vercel resource connection dynamic provider. */
interface VercelResourceConnectionInputs {
	/** Vercel API bearer token. */
	token: string;

	/** Vercel team/org ID. */
	teamId: string;

	/** Integration configuration ID (e.g. `"icfg_…"`). */
	integrationConfigurationId: string;

	/** The external resource ID of the provisioned marketplace store. */
	resourceId: string;

	/** The Vercel project ID to connect the resource to. */
	projectId: string;

	/** Deployment environments to inject env vars into. */
	targets: string[];
}

/** Persisted state for the Vercel resource connection. */
type VercelResourceConnectionOutputs = VercelResourceConnectionInputs;

/**
 * Dynamic provider that connects a Vercel marketplace resource to a project,
 * injecting env vars into the specified deployment environments.
 *
 * @internal Exported only for unit testing; not part of the public API surface.
 */
export class VercelResourceConnectionProvider
	implements pulumi.dynamic.ResourceProvider
{
	async create(
		inputs: VercelResourceConnectionInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		const response = await fetch(
			`${VERCEL_API_URL}/v1/integrations/installations/${inputs.integrationConfigurationId}/resources/${inputs.resourceId}/connections?teamId=${inputs.teamId}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${inputs.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					projectId: inputs.projectId,
					envVarEnvironments: inputs.targets,
					makeEnvVarsSensitive: true,
				}),
			},
		);

		if (!response.ok) {
			throw new Error(
				`Vercel resource connection failed (${response.status}): ${await response.text()}`,
			);
		}

		const outs: VercelResourceConnectionOutputs = { ...inputs };

		return { id: `${inputs.resourceId}:${inputs.projectId}`, outs };
	}

	async read(
		id: string,
		props: VercelResourceConnectionOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		// There is no public read endpoint for resource connections; drift is not refreshed here.
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

		if (olds.integrationConfigurationId !== news.integrationConfigurationId) {
			replaces.push("integrationConfigurationId");
		}

		if (olds.resourceId !== news.resourceId) {
			replaces.push("resourceId");
		}

		if (olds.projectId !== news.projectId) {
			replaces.push("projectId");
		}

		// targets comparison is order-sensitive by design: the array is sent verbatim to the
		// API as envVarEnvironments, so reordering is a meaningful change.
		if (JSON.stringify(olds.targets) !== JSON.stringify(news.targets)) {
			replaces.push("targets");
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
			integrationConfigurationId: pulumi.Input<string>;
			resourceId: pulumi.Input<string>;
			projectId: pulumi.Input<string>;
			targets: pulumi.Input<string[]>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(new VercelResourceConnectionProvider(), name, { ...args }, opts);
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
	 * Integration configuration ID (e.g. `"icfg_…"`).
	 * Obtain this from {@link VercelIntegration.configurationId}.
	 */
	integrationConfigurationId: pulumi.Input<string>;

	/**
	 * The external resource ID of the provisioned marketplace store.
	 * Obtain this from {@link VercelMarketplaceResource.externalResourceId}.
	 */
	resourceId: pulumi.Input<string>;

	/** The Vercel project ID to connect the resource to. */
	projectId: pulumi.Input<string>;

	/**
	 * Deployment environments into which the integration env vars will be injected.
	 * Typical values: `["production", "preview", "development"]`.
	 */
	targets: pulumi.Input<string[]>;
}

/**
 * Connects a Vercel marketplace resource to a project, injecting its env vars
 * as sensitive variables into the specified deployment environments.
 *
 * Calls `POST /v1/integrations/installations/{icfg}/resources/{resourceId}/connections`.
 * Deletion is a no-op — there is no public per-project disconnect endpoint;
 * disconnect manually from the Vercel dashboard if needed.
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
 * new VercelResourceConnection("humanes-kv-conn", {
 *   integrationConfigurationId: upstash.configurationId,
 *   resourceId: kvStore.externalResourceId,
 *   projectId: humanesProject.id,
 *   targets: ["production", "preview", "development"],
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
				...args,
			},
			{ parent: this },
		);

		this.registerOutputs({});
	}
}
