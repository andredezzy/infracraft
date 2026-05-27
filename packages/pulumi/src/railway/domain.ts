import * as pulumi from "@pulumi/pulumi";
import { RailwayClient } from "./client.js";

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
 *
 * @param client Authenticated Railway API client
 * @param projectId Railway project UUID
 * @param serviceId Railway service UUID
 * @param environmentId Railway environment UUID
 * @returns Separate arrays of service domains and custom domains with their IDs and FQDNs
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
 * Uses adopt-or-create: queries existing domains before creating new ones
 * to prevent duplicates. Uses the FQDN as the Pulumi resource ID so
 * `domain.id` returns the domain name directly (useful for URL composition).
 *
 * Supports both auto-generated Railway service domains and custom domains.
 */
class RailwayDomainProvider implements pulumi.dynamic.ResourceProvider {
	/**
	 * Creates or adopts a Railway domain.
	 *
	 * If `customDomain` is set, creates/adopts a custom domain.
	 * Otherwise, creates/adopts an auto-generated Railway service domain.
	 *
	 * @param inputs Resolved domain configuration
	 * @returns The FQDN as the resource ID
	 */
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

	/**
	 * Reads current state for `pulumi refresh` by querying existing domains.
	 *
	 * @param id Current FQDN resource ID
	 * @param props Last known persisted state
	 * @returns Refreshed resource ID and properties
	 * @throws {Error} If the domain no longer exists in Railway
	 */
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

	/**
	 * Deletes the Railway domain. Uses `domainId` (UUID) for the API call.
	 * Silently succeeds if already deleted.
	 *
	 * @param _id Current FQDN resource ID (unused for API call)
	 * @param props Last known persisted state (contains `domainId` for deletion)
	 */
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

	/**
	 * Compares old and new inputs to determine what changed.
	 *
	 * Triggers replacement when `serviceId`, `customDomain`, or `environmentId` changes,
	 * since domains cannot be moved between services or environments.
	 *
	 * @param _id Current resource ID (unused)
	 * @param olds Previous persisted state
	 * @param news New desired configuration
	 * @returns Diff result with replacement triggers
	 */
	async diff(
		_id: string,
		olds: RailwayDomainOutputs,
		news: RailwayDomainInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.serviceId !== news.serviceId) replaces.push("serviceId");
		if (olds.customDomain !== news.customDomain) replaces.push("customDomain");
		if (olds.environmentId !== news.environmentId) replaces.push("environmentId");

		return {
			changes: replaces.length > 0,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/**
 * Manages a Railway domain (service or custom) with adopt-or-create semantics.
 *
 * Uses the FQDN as the Pulumi resource ID so `domain.id` returns the domain name
 * directly, enabling `pulumi.interpolate\`https://${domain.id}\`` for URL composition.
 *
 * @example
 * ```typescript
 * const domain = new RailwayDomain("railway-domain-api", {
 *   token: project.projectToken,
 *   projectId: project.projectId,
 *   serviceId: service.serviceId,
 *   environmentId: project.productionEnvironmentId,
 * });
 *
 * const url = pulumi.interpolate`https://${domain.id}`;
 * ```
 */
export class RailwayDomain extends pulumi.dynamic.Resource {
	/**
	 * @param name Pulumi resource name (logical identifier in state)
	 * @param args Domain configuration inputs
	 * @param opts Standard Pulumi resource options (e.g. `dependsOn`, `parent`)
	 */
	constructor(
		name: string,
		args: {
			/** Railway API bearer token. */
			token: pulumi.Input<string>;

			/** Railway project UUID. */
			projectId: pulumi.Input<string>;

			/** Railway service UUID to attach the domain to. */
			serviceId: pulumi.Input<string>;

			/** Railway environment UUID (e.g. production). */
			environmentId: pulumi.Input<string>;

			/** Custom domain FQDN. Omit to create an auto-generated Railway service domain. */
			customDomain?: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new RailwayDomainProvider(),
			name,
			{ ...args, domainId: undefined, fqdn: undefined },
			opts,
		);
	}
}
