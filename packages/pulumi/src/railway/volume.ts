import * as pulumi from "@pulumi/pulumi";
import { isResolvedString } from "../dynamic/is-resolved-string";
import { resolveCredential } from "../dynamic/resolve-credential";
import { RailwayClient } from "./client";
import type { RailwayEnvironment } from "./environment";
import type { RailwayProject } from "./project";
import type { RailwayProvider } from "./provider";
import type { RailwayService } from "./service";

/** Resolved inputs for the Railway volume dynamic provider. */
export interface RailwayVolumeInputs {
	/** Railway API bearer token. Absent when `tokenEnvVar` is used instead. */
	token?: string;

	/** Env var name resolved to the token when `token` is absent (see `RailwayProviderArgs.tokenEnvVar`). */
	tokenEnvVar?: string;

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

const VOLUME_ATTACH_DEPLOY = `
  mutation($serviceId: String!, $environmentId: String!) {
    serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
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
                  environmentId
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
 * Finds an existing volume attached to a specific service IN a specific
 * environment. Both must match: services are project-level and shared across
 * environments, so matching by service alone made a new stack adopt a SIBLING
 * environment's volume (production adopted staging's, live incident
 * 2026-07-06) — volume instances are per-environment, and so is adoption.
 */
async function findAttachedVolume(
	client: RailwayClient,
	projectId: string,
	serviceId: string,
	environmentId: string,
): Promise<string | undefined> {
	const result = await client.query<{
		project: {
			volumes: {
				edges: Array<{
					node: {
						id: string;
						volumeInstances: {
							edges: Array<{
								node: { serviceId: string; environmentId: string };
							}>;
						};
					};
				}>;
			};
		};
	}>(VOLUMES_QUERY, { projectId });

	const match = result.project.volumes.edges.find((edge) =>
		edge.node.volumeInstances.edges.some(
			(vi) =>
				vi.node.serviceId === serviceId &&
				vi.node.environmentId === environmentId,
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
export class RailwayVolumeResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
	/**
	 * Validates inputs at plan time. A relative `mountPath` would otherwise
	 * fail deep inside `volumeCreate` with an opaque GraphQL error.
	 */
	async check(
		_olds: RailwayVolumeInputs,
		news: RailwayVolumeInputs,
	): Promise<pulumi.dynamic.CheckResult<RailwayVolumeInputs>> {
		const failures: pulumi.dynamic.CheckFailure[] = [];

		if (isResolvedString(news.mountPath) && !news.mountPath.startsWith("/")) {
			failures.push({
				property: "mountPath",
				reason: `mountPath must be an absolute path starting with "/", got "${news.mountPath}"`,
			});
		}

		return { inputs: news, failures };
	}

	async create(
		inputs: RailwayVolumeInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		const client = new RailwayClient(
			resolveCredential(inputs.token, inputs.tokenEnvVar),
		);

		let volumeId = await findAttachedVolume(
			client,
			inputs.projectId,
			inputs.serviceId,
			inputs.environmentId,
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

			// A volume mounts into the container only on the NEXT deployment —
			// attaching alone changes nothing for a running service (the dashboard
			// redeploys after attach for the same reason). Best-effort: a service
			// with no deployable source yet (code service before its first
			// `railway up`) has nothing to redeploy, and its mount lands with that
			// first deploy anyway.
			try {
				await client.query(VOLUME_ATTACH_DEPLOY, {
					serviceId: inputs.serviceId,
					environmentId: inputs.environmentId,
				});
			} catch (error) {
				pulumi.log.warn(
					`Volume attached; redeploy skipped (service not deployable yet?): ${String(error)}`,
				);
			}
		}

		return {
			id: volumeId,
			outs: { ...inputs, volumeId },
		};
	}

	async read(
		id: string,
		props: RailwayVolumeOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new RailwayClient(
			resolveCredential(props.token, props.tokenEnvVar),
		);

		let volumeId: string | undefined;

		try {
			volumeId = await findAttachedVolume(
				client,
				props.projectId,
				props.serviceId,
				props.environmentId,
			);
		} catch (error) {
			pulumi.log.warn(
				`Railway volume refresh lookup failed; keeping existing state: ${String(error)}`,
			);
		}

		// A project-level service's volume can be momentarily unresolvable at
		// refresh (eventual consistency / environment-scoped volume instances), so
		// fall back to the stored id rather than throwing — that turned a healthy
		// volume into a refresh error. A genuinely-deleted volume is re-adopted or
		// recreated on the next `up` (create is adopt-or-create). `read` never
		// fabricates drift and never hard-fails.
		const resolvedId = volumeId ?? props.volumeId ?? id;

		return { id: resolvedId, props: { ...props, volumeId: resolvedId } };
	}

	async delete(id: string, props: RailwayVolumeOutputs): Promise<void> {
		const client = new RailwayClient(
			resolveCredential(props.token, props.tokenEnvVar),
		);

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
			token?: pulumi.Input<string>;
			tokenEnvVar?: pulumi.Input<string>;
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
			// The API token flows into dynamic-provider state with the outputs — mark it secret there.
			{ ...opts, additionalSecretOutputs: ["token"] },
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
				tokenEnvVar: provider.tokenEnvVar,
				projectId: project.id,
				serviceId: service.id,
				environmentId: environment.id,
				mountPath: args.mountPath,
			},
			// Forward the consumer's resource options to the underlying resource. Pulumi
			// auto-inherits `provider`/`protect` from the parent component, but NOT options
			// like `retainOnDelete` — without this pass-through, setting `retainOnDelete` on a
			// RailwayVolume would silently never reach the actual cloud volume.
			pulumi.mergeOptions(pulumiOpts, { parent: this }),
		);

		this.registerOutputs({});
	}
}
