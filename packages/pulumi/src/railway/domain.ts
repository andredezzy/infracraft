import * as pulumi from "@pulumi/pulumi";
import { RailwayClient } from "./client.js";
import type { RailwayEnvironment } from "./environment.js";
import type { RailwayProject } from "./project.js";
import type { RailwayProvider } from "./provider.js";
import type { RailwayService } from "./service.js";

/** Resolved inputs for the Railway domain dynamic provider. */
export interface RailwayDomainInputs {
	/** Railway API bearer token. */
	token: string;

	/** Railway project UUID. */
	projectId: string;

	/** Railway service UUID to attach the domain to. */
	serviceId: string;

	/** Railway environment UUID (e.g. production). */
	environmentId: string;

	/** Custom domain FQDN (e.g. `"api.example.com"`). Omit for auto-generated Railway domain. */
	customDomain?: string;
}

/** Persisted state for the Railway domain, extending inputs with Railway-assigned identifiers. */
interface RailwayDomainOutputs extends RailwayDomainInputs {
	/** Railway-assigned domain UUID (used for deletion API calls). */
	domainId: string;

	/** Fully qualified domain name (e.g. `"api-production-abc.up.railway.app"`). */
	fqdn: string;
}

const SERVICE_DOMAINS_QUERY = `
  query($projectId: String!, $serviceId: String!, $environmentId: String!) {
    domains(
      projectId: $projectId
      serviceId: $serviceId
      environmentId: $environmentId
    ) {
      serviceDomains { id domain }
      customDomains { id domain }
    }
  }
`;

const SERVICE_DOMAIN_CREATE = `
  mutation($input: ServiceDomainCreateInput!) {
    serviceDomainCreate(input: $input) { id domain }
  }
`;

const CUSTOM_DOMAIN_CREATE = `
  mutation($input: CustomDomainCreateInput!) {
    customDomainCreate(input: $input) { id domain }
  }
`;

const CUSTOM_DOMAIN_DELETE = `
  mutation($id: String!) { customDomainDelete(id: $id) }
`;

const SERVICE_DOMAIN_DELETE = `
  mutation($id: String!) { serviceDomainDelete(id: $id) }
`;

/**
 * Queries all existing domains (service and custom) for a Railway service.
 */
async function findExistingDomains(
	client: RailwayClient,
	projectId: string,
	serviceId: string,
	environmentId: string,
): Promise<{
	serviceDomains: Array<{ id: string; domain: string }>;
	customDomains: Array<{ id: string; domain: string }>;
}> {
	const result = await client.query<{
		domains: {
			serviceDomains: Array<{ id: string; domain: string }>;
			customDomains: Array<{ id: string; domain: string }>;
		};
	}>(SERVICE_DOMAINS_QUERY, { projectId, serviceId, environmentId });

	return result.domains;
}

/**
 * Dynamic provider implementing CRUD for Railway domains.
 *
 * Uses adopt-or-create: queries existing domains before creating new ones.
 * Uses the FQDN as the Pulumi resource ID.
 */
class RailwayDomainResourceProvider implements pulumi.dynamic.ResourceProvider {
	async create(
		inputs: RailwayDomainInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		const client = new RailwayClient(inputs.token);

		const existing = await findExistingDomains(
			client,
			inputs.projectId,
			inputs.serviceId,
			inputs.environmentId,
		);

		if (inputs.customDomain) {
			const found = existing.customDomains.find(
				(d) => d.domain === inputs.customDomain,
			);

			if (found) {
				pulumi.log.info(`Adopting existing custom domain "${found.domain}"`);

				return {
					id: found.domain,
					outs: { ...inputs, domainId: found.id, fqdn: found.domain },
				};
			}

			const result = await client.query<{
				customDomainCreate: { id: string; domain: string };
			}>(CUSTOM_DOMAIN_CREATE, {
				input: {
					projectId: inputs.projectId,
					serviceId: inputs.serviceId,
					environmentId: inputs.environmentId,
					domain: inputs.customDomain,
				},
			});

			return {
				id: result.customDomainCreate.domain,
				outs: {
					...inputs,
					domainId: result.customDomainCreate.id,
					fqdn: result.customDomainCreate.domain,
				},
			};
		}

		if (existing.serviceDomains.length > 0) {
			const found = existing.serviceDomains[0];

			pulumi.log.info(`Adopting existing service domain "${found.domain}"`);

			return {
				id: found.domain,
				outs: { ...inputs, domainId: found.id, fqdn: found.domain },
			};
		}

		const result = await client.query<{
			serviceDomainCreate: { id: string; domain: string };
		}>(SERVICE_DOMAIN_CREATE, {
			input: {
				serviceId: inputs.serviceId,
				environmentId: inputs.environmentId,
			},
		});

		return {
			id: result.serviceDomainCreate.domain,
			outs: {
				...inputs,
				domainId: result.serviceDomainCreate.id,
				fqdn: result.serviceDomainCreate.domain,
			},
		};
	}

	async read(
		_id: string,
		props: RailwayDomainOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new RailwayClient(props.token);

		const existing = await findExistingDomains(
			client,
			props.projectId,
			props.serviceId,
			props.environmentId,
		);

		if (props.customDomain) {
			const found = existing.customDomains.find(
				(d) => d.domain === props.customDomain,
			);

			if (!found) {
				throw new Error(
					`Custom domain "${props.customDomain}" not found during refresh`,
				);
			}

			return {
				id: found.domain,
				props: { ...props, domainId: found.id, fqdn: found.domain },
			};
		}

		if (existing.serviceDomains.length > 0) {
			const found = existing.serviceDomains[0];

			return {
				id: found.domain,
				props: { ...props, domainId: found.id, fqdn: found.domain },
			};
		}

		throw new Error("Railway domain not found during refresh");
	}

	async delete(_id: string, props: RailwayDomainOutputs): Promise<void> {
		const client = new RailwayClient(props.token);

		const mutation = props.customDomain
			? CUSTOM_DOMAIN_DELETE
			: SERVICE_DOMAIN_DELETE;

		try {
			await client.query(mutation, { id: props.domainId });
		} catch {
			pulumi.log.warn(
				"Failed to delete Railway domain (may already be deleted)",
			);
		}
	}

	async diff(
		_id: string,
		olds: RailwayDomainOutputs,
		news: RailwayDomainInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.serviceId !== news.serviceId) {
			replaces.push("serviceId");
		}

		if (olds.customDomain !== news.customDomain) {
			replaces.push("customDomain");
		}

		if (olds.environmentId !== news.environmentId) {
			replaces.push("environmentId");
		}

		return {
			changes: replaces.length > 0,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/** Internal dynamic resource — not part of the public API. */
class RailwayDomainResource extends pulumi.dynamic.Resource {
	public declare readonly fqdn: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			token: pulumi.Input<string>;
			projectId: pulumi.Input<string>;
			serviceId: pulumi.Input<string>;
			environmentId: pulumi.Input<string>;
			customDomain?: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new RailwayDomainResourceProvider(),
			name,
			{ ...args, domainId: undefined, fqdn: undefined },
			opts,
		);
	}
}

/** Options type for RailwayDomain — replaces Pulumi's native `provider` field. */
type RailwayDomainOptions = Omit<
	pulumi.ComponentResourceOptions,
	"provider"
> & {
	/** Railway authentication context. */
	provider: RailwayProvider;

	/** Railway project context. */
	project: RailwayProject;

	/** Railway environment context. */
	environment: RailwayEnvironment;

	/** Railway service context. */
	service: RailwayService;
};

/** Args for RailwayDomain. */
export interface RailwayDomainArgs {
	/** Custom domain FQDN. Omit to create an auto-generated Railway service domain. */
	customDomain?: pulumi.Input<string>;
}

/**
 * Manages a Railway domain (service or custom) with adopt-or-create semantics.
 *
 * @example
 * ```typescript
 * const domain = new RailwayDomain("api-domain", {}, {
 *   provider, project, environment, service,
 * });
 *
 * const url = pulumi.interpolate`https://${domain.fqdn}`;
 * ```
 */
export class RailwayDomain extends pulumi.ComponentResource {
	/** Fully qualified domain name. */
	public readonly fqdn: pulumi.Output<string>;

	constructor(
		name: string,
		args: RailwayDomainArgs,
		opts: RailwayDomainOptions,
	) {
		const { provider, project, environment, service, ...pulumiOpts } = opts;

		super("infracraft:railway:Domain", name, {}, pulumiOpts);

		const resource = new RailwayDomainResource(
			`${name}-resource`,
			{
				token: provider.token,
				projectId: project.projectId,
				serviceId: service.serviceId,
				environmentId: environment.environmentId,
				customDomain: args.customDomain,
			},
			{ parent: this },
		);

		this.fqdn = resource.fqdn;

		this.registerOutputs({ fqdn: this.fqdn });
	}
}
