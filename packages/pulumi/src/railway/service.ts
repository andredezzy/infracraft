import * as pulumi from "@pulumi/pulumi";
import { isResolvedString } from "../dynamic/is-resolved-string";
import { RailwayClient } from "./client";
import type { RailwayEnvironment } from "./environment";
import type { RailwayProject } from "./project";
import type { RailwayProvider } from "./provider";

/**
 * Railway build system. Enum keys are UPPERCASE per convention; values are
 * Railway's required UPPERCASE wire literals.
 * Note: HEROKU and PAKETO were deprecated Feb 21 2025 and auto-migrated to
 * NIXPACKS by Railway, but remain in the schema and are accepted by the API.
 */
export enum RailwayBuilder {
	RAILPACK = "RAILPACK",
	NIXPACKS = "NIXPACKS",
	DOCKERFILE = "DOCKERFILE",
	HEROKU = "HEROKU",
	PAKETO = "PAKETO",
}

/**
 * Railway service restart policy. Controls when Railway restarts the service
 * container after it exits. Default is ON_FAILURE.
 */
export enum RailwayRestartPolicy {
	ON_FAILURE = "ON_FAILURE",
	ALWAYS = "ALWAYS",
	NEVER = "NEVER",
}

/** Docker image source for a Railway service (e.g. `redis:8-alpine`). */
interface RailwayServiceSource {
	/** Full Docker image reference including tag. */
	image: string;
}

/** Resolved inputs for the Railway service dynamic provider. */
interface RailwayServiceInputs {
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

	/** Build system to use when building the service. */
	builder?: RailwayBuilder;

	/** Shell command executed during the build phase. */
	buildCommand?: string;

	/** Shell command executed to start the service at runtime. */
	startCommand?: string;

	/** Restart behavior for the service container. */
	restartPolicyType?: RailwayRestartPolicy;

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

const SERVICE_INSTANCE_DEPLOY = `
  mutation($serviceId: String!, $environmentId: String!) {
    serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
  }
`;

/**
 * Triggers a deployment of the service instance in the target environment.
 * Image-sourced services never deploy there on their own: `serviceCreate`'s
 * auto-deploy only reaches the project's DEFAULT environment, and
 * `serviceInstanceUpdate` applies config without redeploying — so a service
 * in any other environment stays undeployed forever and its private DNS name
 * never registers. `environmentTriggersDeploy` is no alternative: it returns
 * success without creating anything for a service that has never deployed in
 * that environment (proven live, 2026-07-06).
 */
async function deployServiceInstance(
	client: RailwayClient,
	serviceId: string,
	environmentId: string,
): Promise<void> {
	const result = await client.query<{ serviceInstanceDeployV2: string }>(
		SERVICE_INSTANCE_DEPLOY,
		{ serviceId, environmentId },
	);

	pulumi.log.info(
		`[infracraft] serviceInstanceDeployV2 created deployment ${result.serviceInstanceDeployV2}`,
	);
}

const SERVICE_INSTANCE_QUERY = `
  query($serviceId: String!, $environmentId: String!) {
    serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
      id
    }
  }
`;

const ENVIRONMENT_UNSKIP_SERVICE = `
  mutation($serviceId: String!, $environmentId: String!) {
    environmentUnskipService(serviceId: $serviceId, environmentId: $environmentId)
  }
`;

/**
 * Guarantees the service has an instance in the target environment.
 *
 * `serviceCreate` materializes an instance ONLY in the environment passed at
 * create time; in every other environment the service is "skipped" — no
 * instance exists there, `serviceInstanceUpdate` returns true while silently
 * doing nothing, and `railway up` fails with UPLOAD_FAILED 404 (live incident:
 * first-ever mesh deploy to production). `environmentUnskipService` is the
 * mutation the dashboard's per-environment enable uses; it also returns a bare
 * boolean, so the instance is re-queried afterward and a still-missing
 * instance is a loud error rather than a fourth silent no-op.
 */
async function ensureServiceInstance(
	client: RailwayClient,
	serviceId: string,
	environmentId: string,
): Promise<void> {
	const exists = async (): Promise<boolean> => {
		try {
			const result = await client.query<{
				serviceInstance: { id: string } | null;
			}>(SERVICE_INSTANCE_QUERY, { serviceId, environmentId });

			return Boolean(result.serviceInstance);
		} catch (error) {
			if (error instanceof Error && /not found/i.test(error.message)) {
				return false;
			}

			throw error;
		}
	};

	if (await exists()) {
		return;
	}

	pulumi.log.info(
		`[infracraft] service ${serviceId} has no instance in environment ${environmentId} — unskipping`,
	);

	await client.query(ENVIRONMENT_UNSKIP_SERVICE, { serviceId, environmentId });

	if (!(await exists())) {
		throw new Error(
			`Railway service ${serviceId} still has no instance in environment ${environmentId} after environmentUnskipService — cannot configure or deploy it`,
		);
	}
}

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

	// Source must be applied PER ENVIRONMENT: `ServiceCreateInput.source` only
	// configures the instance of the environment passed at create time, and every
	// other environment's instance is born with source=null — deploy triggers
	// then no-op silently because there is nothing to deploy.
	if (inputs.source) {
		instanceInput.source = { image: inputs.source.image };
	}

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
 *
 * @internal Exported only for unit testing; not part of the public API surface.
 */
export class RailwayServiceResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
	/**
	 * Validates inputs at plan time. An empty `source.image` would otherwise
	 * fail deep inside `serviceInstanceUpdate` with an opaque GraphQL error.
	 */
	async check(
		_olds: RailwayServiceInputs,
		news: RailwayServiceInputs,
	): Promise<pulumi.dynamic.CheckResult<RailwayServiceInputs>> {
		const failures: pulumi.dynamic.CheckFailure[] = [];

		if (
			news.source &&
			isResolvedString(news.source.image) &&
			news.source.image.trim().length === 0
		) {
			failures.push({
				property: "source.image",
				reason:
					'source.image must be a non-empty Docker image reference (e.g. "redis:8-alpine")',
			});
		}

		return { inputs: news, failures };
	}

	/**
	 * Creates or adopts a Railway service by name, then applies instance config.
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
				environmentId: inputs.environmentId,
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

		await ensureServiceInstance(client, serviceId, inputs.environmentId);
		await applyInstanceConfig(client, serviceId, inputs.environmentId, inputs);

		// Image services have no `railway up` step (see RailwayDeploy for code
		// services) — the provider owns their deploy.
		if (inputs.source) {
			await deployServiceInstance(client, serviceId, inputs.environmentId);
		}

		const outs: RailwayServiceOutputs = { ...inputs, serviceId };

		return { id: serviceId, outs };
	}

	/**
	 * Updates service name/icon and re-applies instance configuration.
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

		await ensureServiceInstance(client, id, news.environmentId);
		await applyInstanceConfig(client, id, news.environmentId, news);

		// Instance config changes (source, startCommand, …) only take effect on
		// the next deployment; image services get none unless the provider
		// triggers it.
		if (news.source) {
			await deployServiceInstance(client, id, news.environmentId);
		}

		const outs: RailwayServiceOutputs = { ...news, serviceId: id };

		return { outs };
	}

	/**
	 * Reads current state for `pulumi refresh` by querying the service by ID.
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
			// Resource gone → blank id lets refresh reconcile the deletion.
			return {};
		}

		return { id, props: { ...props, serviceId: id } };
	}

	/**
	 * Deletion is a no-op. A Railway service is a project-level resource shared
	 * across environments (forked environments adopt it by name), so a single
	 * environment's destroy must never delete it. Deleting the *environment*
	 * removes that environment's service instances instead.
	 */
	async delete(): Promise<void> {
		pulumi.log.warn(
			"Railway service deletion skipped — services are project-level; delete the environment to remove its instances",
		);
	}

	/**
	 * Compares old and new inputs to determine what changed.
	 *
	 * ProjectId and environmentId changes trigger replacement.
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
			// serviceId survives every in-place update (only projectId/environmentId
			// changes replace), so declaring it stable keeps it known during preview —
			// dependents (e.g. RailwayVolume) no longer see an unknown serviceId and
			// stop showing phantom replaces.
			stables: replaces.length === 0 ? ["serviceId"] : [],
			deleteBeforeReplace: true,
		};
	}
}

/** Internal dynamic resource — not part of the public API. */
class RailwayServiceResource extends pulumi.dynamic.Resource {
	public declare readonly serviceId: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			token: pulumi.Input<string>;
			projectId: pulumi.Input<string>;
			environmentId: pulumi.Input<string>;
			name: pulumi.Input<string>;
			icon?: pulumi.Input<string>;
			source?: pulumi.Input<{ image: pulumi.Input<string> }>;
			builder?: pulumi.Input<RailwayBuilder>;
			buildCommand?: pulumi.Input<string>;
			startCommand?: pulumi.Input<string>;
			restartPolicyType?: pulumi.Input<RailwayRestartPolicy>;
			healthcheckPath?: pulumi.Input<string>;
			healthcheckTimeout?: pulumi.Input<number>;
			preDeployCommand?: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new RailwayServiceResourceProvider(),
			name,
			{ ...args, serviceId: undefined },
			// The API token flows into dynamic-provider state with the outputs — mark it secret there.
			{ ...opts, additionalSecretOutputs: ["token"] },
		);
	}
}

/** Options type for RailwayService — replaces Pulumi's native `provider` field. */
type RailwayServiceOptions = Omit<
	pulumi.ComponentResourceOptions,
	"provider"
> & {
	/** Railway authentication context. */
	provider: RailwayProvider;

	/** Railway project context. */
	project: RailwayProject;

	/** Railway environment context. */
	environment: RailwayEnvironment;
};

/** Args for RailwayService. */
export interface RailwayServiceArgs {
	/** Human-readable service name used for adopt-or-create matching. */
	name: pulumi.Input<string>;

	/** SVG icon URL displayed in the Railway dashboard. */
	icon?: pulumi.Input<string>;

	/** Docker image source for image-based services. */
	source?: pulumi.Input<{ image: pulumi.Input<string> }>;

	/** Build system to use when building the service. */
	builder?: pulumi.Input<RailwayBuilder>;

	/** Shell command executed during the build phase. */
	buildCommand?: pulumi.Input<string>;

	/** Shell command executed to start the service at runtime. */
	startCommand?: pulumi.Input<string>;

	/** Restart behavior for the service container. */
	restartPolicyType?: pulumi.Input<RailwayRestartPolicy>;

	/** HTTP path polled for health checks (e.g. `"/health-check"`). */
	healthcheckPath?: pulumi.Input<string>;

	/** Seconds to wait for a healthy response before marking unhealthy. */
	healthcheckTimeout?: pulumi.Input<number>;

	/** Shell command executed before the main deploy (e.g. migrations). */
	preDeployCommand?: pulumi.Input<string>;
}

/**
 * Manages a Railway service with adopt-or-create semantics.
 *
 * @example
 * ```typescript
 * const service = new RailwayService("api", {
 *   name: "api",
 *   builder: RailwayBuilder.RAILPACK,
 *   startCommand: "node dist/index.js",
 *   healthcheckPath: "/health",
 * }, { provider, project, environment });
 *
 * // Use serviceId downstream
 * new RailwayVariable("api-vars", {
 *   variables: { DATABASE_URL: dbUrl },
 * }, { provider, project, environment, service });
 * ```
 */
export class RailwayService extends pulumi.ComponentResource {
	/** Railway service UUID. */
	public readonly id: pulumi.Output<string>;

	constructor(
		name: string,
		args: RailwayServiceArgs,
		opts: RailwayServiceOptions,
	) {
		const { provider, project, environment, ...pulumiOpts } = opts;

		super("infracraft:railway:Service", name, {}, pulumiOpts);

		const resource = new RailwayServiceResource(
			`${name}-resource`,
			{
				token: provider.token,
				projectId: project.id,
				environmentId: environment.id,
				...args,
			},
			{ parent: this },
		);

		this.id = resource.serviceId;

		this.registerOutputs({ id: this.id });
	}
}
