import * as pulumi from "@pulumi/pulumi";
import type { VercelProject } from "./project";
import type { VercelProvider } from "./provider";

const VERCEL_API_URL = "https://api.vercel.com";

/**
 * Fallback CNAME target, used only when Vercel's domain-config endpoint returns no
 * recommendation (see {@link fetchCnameTarget}). Not the primary source of truth —
 * `VercelDomain.cnameTarget` queries Vercel's per-domain recommendation dynamically,
 * since the actual target can vary by account/domain.
 * https://vercel.com/docs/domains/working-with-domains/add-a-domain
 */
const VERCEL_CNAME_TARGET_FALLBACK = "cname.vercel-dns.com";

/** Resolved inputs for the Vercel domain dynamic provider. */
export interface VercelDomainInputs {
	/** Vercel API bearer token. */
	token: string;

	/** Vercel team/org ID. */
	teamId: string;

	/** Vercel project ID to attach the domain to. */
	projectId: string;

	/** Domain name (e.g. `"app.example.com"`). */
	name: string;
}

/** Persisted state for the Vercel domain, extending inputs with verification status. */
interface VercelDomainOutputs extends VercelDomainInputs {
	/** `true` once the domain's DNS has been verified by Vercel. */
	verified: boolean;

	/** The value to CNAME `name` to, per Vercel's own per-domain recommendation. */
	cnameTarget: string;
}

/** Vercel API response shape for a project domain. */
interface VercelDomainResponse {
	name: string;
	projectId: string;
	verified: boolean;
}

/** A single ranked CNAME recommendation from `GET /v6/domains/{domain}/config`. */
interface VercelRecommendedCname {
	rank: number;
	value: string;
}

/**
 * Fetches Vercel's recommended CNAME target for a domain from its DNS config endpoint.
 * Falls back to {@link VERCEL_CNAME_TARGET_FALLBACK} if Vercel returns no recommendation
 * (logged, since that's an unusual state worth noticing rather than silently accepting).
 */
async function fetchCnameTarget(
	token: string,
	teamId: string,
	name: string,
): Promise<string> {
	const response = await fetch(
		`${VERCEL_API_URL}/v6/domains/${encodeURIComponent(name)}/config?teamId=${teamId}`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);

	if (!response.ok) {
		throw new Error(
			`Vercel API error fetching domain config for "${name}" (${response.status}): ${await response.text()}`,
		);
	}

	const { recommendedCNAME = [] } = (await response.json()) as {
		recommendedCNAME?: VercelRecommendedCname[];
	};

	const preferred = [...recommendedCNAME].sort((a, b) => a.rank - b.rank)[0];

	if (!preferred) {
		pulumi.log.info(
			`Vercel returned no recommended CNAME for "${name}" — falling back to "${VERCEL_CNAME_TARGET_FALLBACK}"`,
		);

		return VERCEL_CNAME_TARGET_FALLBACK;
	}

	return preferred.value;
}

/**
 * Fetches a project domain by name. Returns `null` if not attached (404).
 */
async function fetchDomain(
	token: string,
	teamId: string,
	projectId: string,
	name: string,
): Promise<VercelDomainResponse | null> {
	const response = await fetch(
		`${VERCEL_API_URL}/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(name)}?teamId=${teamId}`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);

	if (response.status === 404) {
		return null;
	}

	if (!response.ok) {
		throw new Error(
			`Vercel API error fetching domain "${name}" (${response.status}): ${await response.text()}`,
		);
	}

	return (await response.json()) as VercelDomainResponse;
}

/**
 * Dynamic provider implementing adopt-or-create for a Vercel project domain.
 *
 * On `create()`, calls `GET /v9/projects/{projectId}/domains/{name}`. If found, adopts
 * the existing attachment. If 404, attaches it via `POST /v10/projects/{projectId}/domains`.
 *
 * @internal Exported only for unit testing; not part of the public API surface.
 */
export class VercelDomainResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
	async create(
		inputs: VercelDomainInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		const existing = await fetchDomain(
			inputs.token,
			inputs.teamId,
			inputs.projectId,
			inputs.name,
		);

		if (existing) {
			pulumi.log.info(
				`Adopted existing Vercel domain "${inputs.name}" on project ${inputs.projectId}`,
			);

			const outs: VercelDomainOutputs = {
				...inputs,
				verified: existing.verified,
				cnameTarget: await fetchCnameTarget(
					inputs.token,
					inputs.teamId,
					inputs.name,
				),
			};

			return { id: `${inputs.projectId}/${inputs.name}`, outs };
		}

		const response = await fetch(
			`${VERCEL_API_URL}/v10/projects/${encodeURIComponent(inputs.projectId)}/domains?teamId=${inputs.teamId}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${inputs.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ name: inputs.name }),
			},
		);

		if (!response.ok) {
			throw new Error(
				`Vercel API error creating domain "${inputs.name}" (${response.status}): ${await response.text()}`,
			);
		}

		const created = (await response.json()) as VercelDomainResponse;

		const outs: VercelDomainOutputs = {
			...inputs,
			verified: created.verified,
			cnameTarget: await fetchCnameTarget(
				inputs.token,
				inputs.teamId,
				inputs.name,
			),
		};

		return { id: `${inputs.projectId}/${inputs.name}`, outs };
	}

	async read(
		_id: string,
		props: VercelDomainOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const domain = await fetchDomain(
			props.token,
			props.teamId,
			props.projectId,
			props.name,
		);

		if (!domain) {
			throw new Error(
				`Vercel domain "${props.name}" not found on project ${props.projectId}`,
			);
		}

		return {
			id: `${props.projectId}/${props.name}`,
			props: {
				...props,
				verified: domain.verified,
				cnameTarget: await fetchCnameTarget(
					props.token,
					props.teamId,
					props.name,
				),
			},
		};
	}

	/** All fields replace (see `diff`) — this is never actually invoked. */
	async update(
		_id: string,
		olds: VercelDomainOutputs,
		news: VercelDomainInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		return {
			outs: { ...news, verified: false, cnameTarget: olds.cnameTarget },
		};
	}

	async delete(_id: string, props: VercelDomainOutputs): Promise<void> {
		const response = await fetch(
			`${VERCEL_API_URL}/v9/projects/${encodeURIComponent(props.projectId)}/domains/${encodeURIComponent(props.name)}?teamId=${props.teamId}`,
			{
				method: "DELETE",
				headers: { Authorization: `Bearer ${props.token}` },
			},
		);

		if (response.status === 404) {
			pulumi.log.warn(
				`Vercel domain "${props.name}" already gone from project ${props.projectId}`,
			);

			return;
		}

		if (!response.ok) {
			throw new Error(
				`Vercel API error deleting domain "${props.name}" (${response.status}): ${await response.text()}`,
			);
		}

		pulumi.log.info(
			`Deleted Vercel domain "${props.name}" from project ${props.projectId}`,
		);
	}

	/**
	 * A domain can only be attached to one project, so every field change replaces
	 * rather than updates.
	 */
	async diff(
		_id: string,
		olds: VercelDomainOutputs,
		news: VercelDomainInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.name !== news.name) {
			replaces.push("name");
		}

		if (olds.projectId !== news.projectId) {
			replaces.push("projectId");
		}

		if (olds.teamId !== news.teamId) {
			replaces.push("teamId");
		}

		return {
			changes: replaces.length > 0,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/** Internal dynamic resource — not part of the public API. */
class VercelDomainResource extends pulumi.dynamic.Resource {
	public declare readonly verified: pulumi.Output<boolean>;
	public declare readonly name: pulumi.Output<string>;
	public declare readonly cnameTarget: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			token: pulumi.Input<string>;
			teamId: pulumi.Input<string>;
			projectId: pulumi.Input<string>;
			name: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new VercelDomainResourceProvider(),
			name,
			{ ...args, verified: undefined, cnameTarget: undefined },
			opts,
		);
	}
}

/** Options type for VercelDomain — replaces Pulumi's native `provider` field. */
type VercelDomainOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Vercel authentication context. */
	provider: VercelProvider;

	/** Vercel project to attach the domain to. */
	project: VercelProject;
};

/** Args for VercelDomain. */
export interface VercelDomainArgs {
	/** Domain name (e.g. `"app.example.com"`). */
	name: pulumi.Input<string>;
}

/**
 * Attaches a custom domain to a Vercel project, with adopt-or-create semantics.
 *
 * @example
 * ```typescript
 * const domain = new VercelDomain("aura-domain", { name: "app.example.com" }, { provider, project });
 *
 * // Point app.example.com's DNS CNAME at this value.
 * const cnameTarget = domain.cnameTarget;
 * ```
 */
export class VercelDomain extends pulumi.ComponentResource {
	/** `true` once the domain's DNS has been verified by Vercel. */
	public readonly verified: pulumi.Output<boolean>;

	/** The attached domain name. */
	public readonly name: pulumi.Output<string>;

	/**
	 * The value to CNAME `name` to — Vercel's own recommendation for this specific
	 * domain, fetched fresh from its DNS config endpoint (falls back to a static default
	 * only if Vercel returns no recommendation).
	 */
	public readonly cnameTarget: pulumi.Output<string>;

	constructor(name: string, args: VercelDomainArgs, opts: VercelDomainOptions) {
		const { provider, project, ...pulumiOpts } = opts;

		super("infracraft:vercel:Domain", name, {}, pulumiOpts);

		const resource = new VercelDomainResource(
			`${name}-resource`,
			{
				token: provider.token,
				teamId: provider.teamId,
				projectId: project.id,
				...args,
			},
			{ parent: this },
		);

		this.verified = resource.verified;
		this.name = resource.name;
		this.cnameTarget = resource.cnameTarget;

		this.registerOutputs({
			verified: this.verified,
			name: this.name,
			cnameTarget: this.cnameTarget,
		});
	}
}
