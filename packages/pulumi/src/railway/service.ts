import * as pulumi from "@pulumi/pulumi";
import { RailwayClient } from "./client.js";

/** Docker image source for a Railway service (e.g. `redis:8-alpine`). */
interface RailwayServiceSource {
	/** Full Docker image reference including tag. */
	image: string;
}

/** Resolved inputs for the Railway service dynamic provider. */
export interface RailwayServiceInputs {
	/** Railway API bearer token. */
	token: string;

	/** Railway project UUID. */
	projectId: string;

	/** Railway environment UUID (e.g. production). */
	environmentId: string;

	/** Human-readable service name used for adopt-or-create matching. */
	name: string;

	/** SVG icon URL displayed in the Railway dashboard. */
	icon?: string;

	/** Docker image source for image-based services. */
	source?: RailwayServiceSource;

	/** Build system: `"RAILPACK"`, `"NIXPACKS"`, or `"DOCKERFILE"`. */
	builder?: string;

	/** Shell command executed during the build phase. */
	buildCommand?: string;

	/** Shell command executed to start the service at runtime. */
	startCommand?: string;

	/** Restart behavior: `"ON_FAILURE"`, `"ALWAYS"`, or `"NEVER"`. */
	restartPolicyType?: string;

	/** HTTP path polled for health checks (e.g. `"/health-check"`). */
	healthcheckPath?: string;

	/** Seconds to wait for a healthy response before marking unhealthy. */
	healthcheckTimeout?: number;

	/** Shell command executed before the main deploy (e.g. migrations). */
	preDeployCommand?: string;
}

/** Persisted state for the Railway service, extending inputs with the Railway-assigned ID. */
interface RailwayServiceOutputs extends RailwayServiceInputs {
	/** Railway-assigned service UUID. */
	serviceId: string;
}

const SERVICES_QUERY = `
  query($projectId: String!) {
    project(id: $projectId) {
      services {
        edges {
          node {
            id
            name
          }
        }
      }
    }
  }
`;

const SERVICE_QUERY = `
  query($serviceId: String!) {
    service(id: $serviceId) {
      id
      name
    }
  }
`;

const SERVICE_CREATE = `
  mutation($input: ServiceCreateInput!) {
    serviceCreate(input: $input) {
      id
      name
    }
  }
`;

const SERVICE_UPDATE = `
  mutation($id: String!, $input: ServiceUpdateInput!) {
    serviceUpdate(id: $id, input: $input) {
      id
      name
    }
  }
`;

const SERVICE_INSTANCE_UPDATE = `
  mutation(
    $serviceId: String!
    $environmentId: String!
    $input: ServiceInstanceUpdateInput!
  ) {
    serviceInstanceUpdate(
      serviceId: $serviceId
      environmentId: $environmentId
      input: $input
    )
  }
`;

const SERVICE_CONNECT = `
  mutation($id: String!, $input: ServiceConnectInput!) {
    serviceConnect(id: $id, input: $input) {
      id
    }
  }
`;

const SERVICE_DELETE = `
  mutation($id: String!) { serviceDelete(id: $id) }
`;

/**
 * Applies service instance configuration (builder, commands, healthcheck).
 * Retries without healthcheck fields if the first call fails.
 */
async function applyInstanceConfig(
	client: RailwayClient,
	serviceId: string,
	environmentId: string,
	inputs: RailwayServiceInputs,
): Promise<void> {
	const instanceInput: Record<string, unknown> = {};

	if (inputs.builder) {
		instanceInput.builder = inputs.builder;
	}

	if (inputs.buildCommand) {
		instanceInput.buildCommand = inputs.buildCommand;
	}

	if (inputs.startCommand) {
		instanceInput.startCommand = inputs.startCommand;
	}

	if (inputs.restartPolicyType) {
		instanceInput.restartPolicyType = inputs.restartPolicyType;
	}

	if (inputs.healthcheckPath) {
		instanceInput.healthcheckPath = inputs.healthcheckPath;
	}

	if (inputs.healthcheckTimeout) {
		instanceInput.healthcheckTimeout = inputs.healthcheckTimeout;
	}

	if (inputs.preDeployCommand) {
		instanceInput.preDeployCommand = inputs.preDeployCommand;
	}

	if (Object.keys(instanceInput).length === 0) {
		return;
	}

	try {
		await client.query(SERVICE_INSTANCE_UPDATE, {
			serviceId,
			environmentId,
			input: instanceInput,
		});
	} catch (error) {
		pulumi.log.warn(
			`serviceInstanceUpdate failed, retrying without healthcheck fields: ${error}`,
		);

		delete instanceInput.healthcheckPath;
		delete instanceInput.healthcheckTimeout;

		if (Object.keys(instanceInput).length > 0) {
			await client.query(SERVICE_INSTANCE_UPDATE, {
				serviceId,
				environmentId,
				input: instanceInput,
			});
		}
	}
}

/**
 * Dynamic provider implementing CRUD for Railway services.
 *
 * Uses adopt-or-create on `create()`: queries services by project ID and name
 * before creating a new one. Service instance configuration (builder, commands,
 * healthcheck) is applied via `serviceInstanceUpdate` after create or update.
 */
class RailwayServiceProvider implements pulumi.dynamic.ResourceProvider {
	/**
	 * Creates or adopts a Railway service by name, then applies instance config.
	 *
	 * @param inputs Resolved service configuration
	 * @returns The Railway service UUID as the resource ID
	 */
	async create(
		inputs: RailwayServiceInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		const client = new RailwayClient(inputs.token);

		const result = await client.query<{
			project: {
				services: { edges: Array<{ node: { id: string; name: string } }> };
			};
		}>(SERVICES_QUERY, { projectId: inputs.projectId });

		let serviceId = result.project.services.edges.find(
			(edge) => edge.node.name === inputs.name,
		)?.node.id;

		if (serviceId) {
			pulumi.log.info(
				`Adopted existing Railway service "${inputs.name}" (${serviceId})`,
			);
		} else {
			const createInput: Record<string, unknown> = {
				projectId: inputs.projectId,
				name: inputs.name,
			};

			if (inputs.source) {
				createInput.source = { image: inputs.source.image };
			}

			const created = await client.query<{
				serviceCreate: { id: string; name: string };
			}>(SERVICE_CREATE, { input: createInput });

			serviceId = created.serviceCreate.id;

			pulumi.log.info(
				`Created Railway service "${inputs.name}" (${serviceId})`,
			);

			if (inputs.source) {
				await client.query(SERVICE_CONNECT, {
					id: serviceId,
					input: { image: inputs.source.image },
				});
			}

			if (inputs.icon) {
				await client.query(SERVICE_UPDATE, {
					id: serviceId,
					input: { icon: inputs.icon },
				});
			}
		}

		await applyInstanceConfig(client, serviceId, inputs.environmentId, inputs);

		const outs: RailwayServiceOutputs = { ...inputs, serviceId };

		return { id: serviceId, outs };
	}

	/**
	 * Updates service name/icon and re-applies instance configuration.
	 *
	 * @param id Railway service UUID
	 * @param _olds Previous persisted state
	 * @param news New desired configuration
	 */
	async update(
		id: string,
		olds: RailwayServiceOutputs,
		news: RailwayServiceInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		const client = new RailwayClient(news.token);

		const updateInput: Record<string, unknown> = {};

		if (olds.name !== news.name) {
			updateInput.name = news.name;
		}

		if (news.icon && olds.icon !== news.icon) {
			updateInput.icon = news.icon;
		}

		if (Object.keys(updateInput).length > 0) {
			await client.query(SERVICE_UPDATE, { id, input: updateInput });
		}

		await applyInstanceConfig(client, id, news.environmentId, news);

		const outs: RailwayServiceOutputs = { ...news, serviceId: id };

		return { outs };
	}

	/**
	 * Reads current state for `pulumi refresh` by querying the service by ID.
	 *
	 * @param id Railway service UUID
	 * @param props Last known persisted state
	 */
	async read(
		id: string,
		props: RailwayServiceOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new RailwayClient(props.token);

		try {
			await client.query<{ service: { id: string; name: string } }>(
				SERVICE_QUERY,
				{ serviceId: id },
			);
		} catch {
			throw new Error(`Railway service "${props.name}" (${id}) not found`);
		}

		return { id, props: { ...props, serviceId: id } };
	}

	/**
	 * Deletes the Railway service. Silently succeeds if already deleted.
	 *
	 * @param id Railway service UUID to delete
	 * @param props Last known persisted state (used for token and logging)
	 */
	async delete(id: string, props: RailwayServiceOutputs): Promise<void> {
		const client = new RailwayClient(props.token);

		try {
			await client.query(SERVICE_DELETE, { id });

			pulumi.log.info(`Deleted Railway service "${props.name}" (${id})`);
		} catch {
			pulumi.log.warn(
				`Failed to delete Railway service "${props.name}" (${id}) — may already be deleted`,
			);
		}
	}

	/**
	 * Compares old and new inputs to determine what changed.
	 *
	 * ProjectId and environmentId changes trigger replacement.
	 * Name, builder, commands, and healthcheck changes trigger in-place update.
	 *
	 * @param _id Current resource ID (unused)
	 * @param olds Previous persisted state
	 * @param news New desired configuration
	 */
	async diff(
		_id: string,
		olds: RailwayServiceOutputs,
		news: RailwayServiceInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];
		const changes: string[] = [];

		if (olds.name !== news.name) {
			changes.push("name");
		}

		if (olds.projectId !== news.projectId) {
			replaces.push("projectId");
		}

		if (olds.environmentId !== news.environmentId) {
			replaces.push("environmentId");
		}

		if (olds.builder !== news.builder) {
			changes.push("builder");
		}

		if (olds.buildCommand !== news.buildCommand) {
			changes.push("buildCommand");
		}

		if (olds.startCommand !== news.startCommand) {
			changes.push("startCommand");
		}

		if (olds.restartPolicyType !== news.restartPolicyType) {
			changes.push("restartPolicyType");
		}

		if (olds.healthcheckPath !== news.healthcheckPath) {
			changes.push("healthcheckPath");
		}

		if (olds.healthcheckTimeout !== news.healthcheckTimeout) {
			changes.push("healthcheckTimeout");
		}

		if (olds.preDeployCommand !== news.preDeployCommand) {
			changes.push("preDeployCommand");
		}

		if (olds.icon !== news.icon) {
			changes.push("icon");
		}

		return {
			changes: replaces.length > 0 || changes.length > 0,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/**
 * Manages a Railway service with adopt-or-create semantics.
 *
 * Queries existing services by project ID and name before creating new ones.
 * Service instance configuration (builder, start command, healthcheck) is
 * applied after creation via `serviceInstanceUpdate`.
 *
 * @example
 * ```typescript
 * const service = new RailwayService("railway-service-api", {
 *   token: project.projectToken,
 *   projectId: project.projectId,
 *   environmentId: project.productionEnvironmentId,
 *   name: "@my-app/api",
 *   builder: "RAILPACK",
 *   startCommand: "node dist/index.js",
 *   healthcheckPath: "/health",
 * });
 *
 * // Use serviceId downstream
 * new RailwayVariable("railway-variable-api", {
 *   serviceId: service.serviceId,
 *   ...
 * });
 * ```
 */
export class RailwayService extends pulumi.dynamic.Resource {
	/** Railway service UUID. */
	public declare readonly serviceId: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			/** Railway API bearer token. */
			token: pulumi.Input<string>;

			/** Railway project UUID. */
			projectId: pulumi.Input<string>;

			/** Railway environment UUID (e.g. production). */
			environmentId: pulumi.Input<string>;

			/** Human-readable service name used for adopt-or-create matching. */
			name: pulumi.Input<string>;

			/** SVG icon URL displayed in the Railway dashboard. */
			icon?: pulumi.Input<string>;

			/** Docker image source for image-based services. */
			source?: pulumi.Input<{ image: pulumi.Input<string> }>;

			/** Build system: `"RAILPACK"`, `"NIXPACKS"`, or `"DOCKERFILE"`. */
			builder?: pulumi.Input<string>;

			/** Shell command executed during the build phase. */
			buildCommand?: pulumi.Input<string>;

			/** Shell command executed to start the service at runtime. */
			startCommand?: pulumi.Input<string>;

			/** Restart behavior: `"ON_FAILURE"`, `"ALWAYS"`, or `"NEVER"`. */
			restartPolicyType?: pulumi.Input<string>;

			/** HTTP path polled for health checks (e.g. `"/health-check"`). */
			healthcheckPath?: pulumi.Input<string>;

			/** Seconds to wait for a healthy response before marking unhealthy. */
			healthcheckTimeout?: pulumi.Input<number>;

			/** Shell command executed before the main deploy (e.g. migrations). */
			preDeployCommand?: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new RailwayServiceProvider(),
			name,
			{ ...args, serviceId: undefined },
			opts,
		);
	}
}
