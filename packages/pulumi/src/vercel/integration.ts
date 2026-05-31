import * as pulumi from "@pulumi/pulumi";
import type { VercelProvider } from "./provider";

const VERCEL_API_URL = "https://api.vercel.com";

/** Resolved inputs for the Vercel integration dynamic provider. */
interface VercelIntegrationInputs {
	/** Vercel API bearer token. */
	token: string;

	/** Vercel team/org ID. */
	teamId: string;

	/** Marketplace integration slug (e.g. `"upstash"`, `"neon"`). */
	slug: string;
}

/** Persisted state for the Vercel integration. */
interface VercelIntegrationOutputs extends VercelIntegrationInputs {
	/** Vercel-assigned configuration ID (e.g. `"icfg_…"`). */
	configurationId: string;
}

/** Vercel API response shape for the integration configurations list. */
interface VercelIntegrationsResponse {
	configurations: Array<{ id: string; slug: string }>;
}

/**
 * Dynamic provider that resolves an installed Vercel marketplace integration
 * by its slug to its configuration ID (`icfg_…`).
 *
 * @internal Exported only for unit testing; not part of the public API surface.
 */
export class VercelIntegrationResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
	async create(
		inputs: VercelIntegrationInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		const response = await fetch(
			`${VERCEL_API_URL}/v1/integrations/configurations?teamId=${inputs.teamId}`,
			{ headers: { Authorization: `Bearer ${inputs.token}` } },
		);

		if (!response.ok) {
			throw new Error(
				`Vercel API error fetching integrations (${response.status}): ${await response.text()}`,
			);
		}

		const data = (await response.json()) as VercelIntegrationsResponse;

		const config = data.configurations.find((c) => c.slug === inputs.slug);

		if (!config) {
			throw new Error(
				`Vercel integration "${inputs.slug}" is not installed on this team`,
			);
		}

		const outs: VercelIntegrationOutputs = {
			...inputs,
			configurationId: config.id,
		};

		return { id: config.id, outs };
	}

	async read(
		id: string,
		props: VercelIntegrationOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		// Resolver-only: the integration's configuration id (icfg_…) is stable for the
		// lifetime of an installed integration, so read() does not re-query. If the
		// integration is uninstalled and reinstalled, a subsequent `up` re-resolves via create().
		return { id, props };
	}

	async delete(): Promise<void> {
		pulumi.log.warn(
			"VercelIntegration is a read-only resolver — uninstall the integration from the Vercel dashboard if needed",
		);
	}

	async diff(
		_id: string,
		olds: VercelIntegrationOutputs,
		news: VercelIntegrationInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.teamId !== news.teamId) {
			replaces.push("teamId");
		}

		if (olds.slug !== news.slug) {
			replaces.push("slug");
		}

		return {
			changes: replaces.length > 0,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/** Internal dynamic resource — not part of the public API. */
class VercelIntegrationResource extends pulumi.dynamic.Resource {
	public declare readonly configurationId: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			token: pulumi.Input<string>;
			teamId: pulumi.Input<string>;
			slug: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new VercelIntegrationResourceProvider(),
			name,
			{ ...args, configurationId: undefined },
			opts,
		);
	}
}

/** Options type for VercelIntegration — replaces Pulumi's native `provider` field. */
type VercelIntegrationOptions = Omit<
	pulumi.ComponentResourceOptions,
	"provider"
> & {
	/** Vercel authentication context. */
	provider: VercelProvider;
};

/**
 * Args for {@link VercelIntegration}.
 */
export interface VercelIntegrationArgs {
	/**
	 * Marketplace integration slug (e.g. `"upstash"`, `"neon"`).
	 * The integration must already be installed on the team via the Vercel dashboard.
	 */
	slug: pulumi.Input<string>;
}

/**
 * Resolves an installed Vercel marketplace integration by slug to its
 * configuration ID (`icfg_…`).
 *
 * The integration must be installed on the team via the Vercel dashboard
 * (one-time OAuth step) before this resource can be used. This resource is
 * read-only: it looks up the configuration ID and exposes it for downstream
 * marketplace-store resources.
 *
 * @example
 * ```typescript
 * const upstash = new VercelIntegration("upstash", {
 *   slug: "upstash",
 * }, { provider });
 *
 * // Use configurationId in marketplace store resources
 * export const upstashConfigId = upstash.configurationId;
 * ```
 */
export class VercelIntegration extends pulumi.ComponentResource {
	/** Vercel integration configuration ID (e.g. `"icfg_…"`). */
	public readonly configurationId: pulumi.Output<string>;

	constructor(
		name: string,
		args: VercelIntegrationArgs,
		opts: VercelIntegrationOptions,
	) {
		const { provider, ...pulumiOpts } = opts;

		super("infracraft:vercel:Integration", name, {}, pulumiOpts);

		const resource = new VercelIntegrationResource(
			`${name}-resource`,
			{
				token: provider.token,
				teamId: provider.teamId,
				slug: args.slug,
			},
			{ parent: this },
		);

		this.configurationId = resource.configurationId;

		this.registerOutputs({ configurationId: this.configurationId });
	}
}
