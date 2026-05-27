import * as pulumi from "@pulumi/pulumi";
import { RailwayClient } from "./client.js";

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
 *
 * @param client Authenticated Railway API client
 * @param projectId Railway project UUID to search within
 * @param serviceId Railway service UUID to match volume instances against
 * @returns The volume UUID if found, `undefined` otherwise
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
 * before creating a new one, making `pulumi up` idempotent from zero.
 * Volumes are immutable after creation — changing `serviceId`, `mountPath`,
 * `environmentId`, or `projectId` triggers replacement (delete + create).
 */
class RailwayVolumeProvider implements pulumi.dynamic.ResourceProvider {
	/**
	 * Creates or adopts a Railway volume for the target service.
	 *
	 * @param inputs Resolved volume configuration
	 * @returns The Railway volume UUID as the resource ID
	 */
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

	/**
	 * Reads current state for `pulumi refresh` by looking up the volume.
	 *
	 * @param id Current Railway volume UUID
	 * @param props Last known persisted state
	 * @returns Refreshed resource ID and properties
	 * @throws {Error} If the volume no longer exists in Railway
	 */
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

	/**
	 * Deletes the Railway volume. Silently succeeds if already deleted.
	 *
	 * @param id Railway volume UUID to delete
	 * @param props Last known persisted state (used for token)
	 */
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

	/**
	 * Compares old and new inputs to determine what changed.
	 *
	 * All mutable properties trigger replacement since Railway volumes
	 * cannot be moved between services, mount paths, environments, or projects.
	 *
	 * @param _id Current resource ID (unused)
	 * @param olds Previous persisted state
	 * @param news New desired configuration
	 * @returns Diff result with replacement triggers
	 */
	async diff(
		_id: string,
		olds: RailwayVolumeOutputs,
		news: RailwayVolumeInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.serviceId !== news.serviceId) replaces.push("serviceId");
		if (olds.mountPath !== news.mountPath) replaces.push("mountPath");
		if (olds.environmentId !== news.environmentId) replaces.push("environmentId");
		if (olds.projectId !== news.projectId) replaces.push("projectId");

		return {
			changes: replaces.length > 0,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/**
 * Manages a Railway persistent volume with adopt-or-create semantics.
 *
 * Finds existing volumes attached to the target service before creating
 * new ones. Changing `serviceId`, `mountPath`, `environmentId`, or `projectId`
 * triggers replacement (delete + create with new settings).
 *
 * @example
 * ```typescript
 * new RailwayVolume("railway-volume-redis", {
 *   token: project.projectToken,
 *   projectId: project.projectId,
 *   serviceId: service.serviceId,
 *   environmentId: project.productionEnvironmentId,
 *   mountPath: "/data",
 * });
 * ```
 */
export class RailwayVolume extends pulumi.dynamic.Resource {
	/**
	 * @param name Pulumi resource name (logical identifier in state)
	 * @param args Volume configuration inputs
	 * @param opts Standard Pulumi resource options (e.g. `dependsOn`, `parent`)
	 */
	constructor(
		name: string,
		args: {
			/** Railway API bearer token. */
			token: pulumi.Input<string>;

			/** Railway project UUID. */
			projectId: pulumi.Input<string>;

			/** Railway service UUID to attach the volume to. */
			serviceId: pulumi.Input<string>;

			/** Railway environment UUID (e.g. production). */
			environmentId: pulumi.Input<string>;

			/** Absolute path inside the container where the volume is mounted. */
			mountPath: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new RailwayVolumeProvider(),
			name,
			{ ...args, volumeId: undefined },
			opts,
		);
	}
}
