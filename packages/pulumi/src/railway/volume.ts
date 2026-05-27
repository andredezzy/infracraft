import * as pulumi from "@pulumi/pulumi";
import { RailwayClient } from "./client.js";
import type { RailwayEnvironment } from "./environment.js";
import type { RailwayProject } from "./project.js";
import type { RailwayProvider } from "./provider.js";
import type { RailwayService } from "./service.js";

/** Resolved inputs for the Railway volume dynamic provider. */
export interface RailwayVolumeInputs {
	/** Railway API bearer token. */
	token: string;

	/** Railway project UUID. */
	projectId: string;

	/** Railway service UUID to attach the volume to. */
	serviceId: string;

	/** Railway environment UUID (e.g. production). */
	environmentId: string;

	/** Absolute path inside the container where the volume is mounted (e.g. `"/data"`). */
	mountPath: string;
}

/** Persisted state for the Railway volume, extending inputs with the Railway-assigned ID. */
interface RailwayVolumeOutputs extends RailwayVolumeInputs {
	/** Railway-assigned volume UUID (set after create or adopt). */
	volumeId: string;
}

const VOLUME_CREATE = `
  mutation($input: VolumeCreateInput!) {
    volumeCreate(input: $input) {
      id
      name
    }
  }
`;

const VOLUME_DELETE = `
  mutation($volumeId: String!) {
    volumeDelete(volumeId: $volumeId)
  }
`;

const VOLUMES_QUERY = `
  query($projectId: String!) {
    project(id: $projectId) {
      volumes {
        edges {
          node {
            id
            name
            volumeInstances {
              edges {
                node {
                  id
                  mountPath
                  serviceId
                }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Finds an existing volume attached to a specific service within a project.
 */
async function findVolumeByService(
	client: RailwayClient,
	projectId: string,
	serviceId: string,
): Promise<string | undefined> {
	const result = await client.query<{
		project: {
			volumes: {
				edges: Array<{
					node: {
						id: string;
						volumeInstances: {
							edges: Array<{
								node: { serviceId: string };
							}>;
						};
					};
				}>;
			};
		};
	}>(VOLUMES_QUERY, { projectId });

	const match = result.project.volumes.edges.find((edge) =>
		edge.node.volumeInstances.edges.some(
			(vi) => vi.node.serviceId === serviceId,
		),
	);

	return match?.node.id;
}

/**
 * Dynamic provider implementing CRUD for Railway persistent volumes.
 *
 * Uses adopt-or-create on `create()`: finds an existing volume by service
 * before creating a new one. Volumes are immutable after creation — changing
 * `serviceId`, `mountPath`, `environmentId`, or `projectId` triggers replacement.
 */
class RailwayVolumeResourceProvider implements pulumi.dynamic.ResourceProvider {
	async create(
		inputs: RailwayVolumeInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		const client = new RailwayClient(inputs.token);

		let volumeId = await findVolumeByService(
			client,
			inputs.projectId,
			inputs.serviceId,
		);

		if (volumeId) {
			pulumi.log.info(`Adopting existing volume for service (${volumeId})`);
		} else {
			const result = await client.query<{
				volumeCreate: { id: string };
			}>(VOLUME_CREATE, {
				input: {
					projectId: inputs.projectId,
					serviceId: inputs.serviceId,
					environmentId: inputs.environmentId,
					mountPath: inputs.mountPath,
				},
			});

			volumeId = result.volumeCreate.id;
		}

		return {
			id: volumeId,
			outs: { ...inputs, volumeId },
		};
	}

	async read(
		_id: string,
		props: RailwayVolumeOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new RailwayClient(props.token);

		const volumeId = await findVolumeByService(
			client,
			props.projectId,
			props.serviceId,
		);

		if (!volumeId) {
			throw new Error("Railway volume not found during refresh");
		}

		return { id: volumeId, props: { ...props, volumeId } };
	}

	async delete(id: string, props: RailwayVolumeOutputs): Promise<void> {
		const client = new RailwayClient(props.token);

		try {
			await client.query(VOLUME_DELETE, { volumeId: id });
		} catch {
			pulumi.log.warn(
				"Failed to delete Railway volume (may already be deleted)",
			);
		}
	}

	async diff(
		_id: string,
		olds: RailwayVolumeOutputs,
		news: RailwayVolumeInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.serviceId !== news.serviceId) {
			replaces.push("serviceId");
		}

		if (olds.mountPath !== news.mountPath) {
			replaces.push("mountPath");
		}

		if (olds.environmentId !== news.environmentId) {
			replaces.push("environmentId");
		}

		if (olds.projectId !== news.projectId) {
			replaces.push("projectId");
		}

		return {
			changes: replaces.length > 0,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/** Internal dynamic resource — not part of the public API. */
class RailwayVolumeResource extends pulumi.dynamic.Resource {
	constructor(
		name: string,
		args: {
			token: pulumi.Input<string>;
			projectId: pulumi.Input<string>;
			serviceId: pulumi.Input<string>;
			environmentId: pulumi.Input<string>;
			mountPath: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new RailwayVolumeResourceProvider(),
			name,
			{ ...args, volumeId: undefined },
			opts,
		);
	}
}

/** Options type for RailwayVolume — replaces Pulumi's native `provider` field. */
type RailwayVolumeOptions = Omit<
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

/** Args for RailwayVolume. */
export interface RailwayVolumeArgs {
	/** Absolute path inside the container where the volume is mounted. */
	mountPath: pulumi.Input<string>;
}

/**
 * Manages a Railway persistent volume with adopt-or-create semantics.
 *
 * @example
 * ```typescript
 * new RailwayVolume("api-data", {
 *   mountPath: "/data",
 * }, { provider, project, environment, service });
 * ```
 */
export class RailwayVolume extends pulumi.ComponentResource {
	constructor(
		name: string,
		args: RailwayVolumeArgs,
		opts: RailwayVolumeOptions,
	) {
		const { provider, project, environment, service, ...pulumiOpts } = opts;

		super("infracraft:railway:Volume", name, {}, pulumiOpts);

		new RailwayVolumeResource(
			`${name}-resource`,
			{
				token: provider.token,
				projectId: project.id,
				serviceId: service.id,
				environmentId: environment.id,
				mountPath: args.mountPath,
			},
			{ parent: this },
		);

		this.registerOutputs({});
	}
}
