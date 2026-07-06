import * as pulumi from "@pulumi/pulumi";
import { isResolvedString } from "../dynamic/is-resolved-string";
import { resolveCredential } from "../dynamic/resolve-credential";
import { isGraphqlNotFoundError } from "../http/is-graphql-not-found-error";
import { Client } from "./client";
import type { Environment } from "./environment";
import type { Project } from "./project";
import type { Provider } from "./provider";
import type { Service } from "./service";

/** Resolved inputs for the Railway volume dynamic provider. */
interface VolumeInputs {
	/** Railway API bearer token. Absent when `tokenEnvVar` is used instead. */
	token?: string;

	/** Env var name resolved to the token when `token` is absent (see `ProviderArgs.tokenEnvVar`). */
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
interface VolumeOutputs extends VolumeInputs {
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
	client: Client,
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
export class VolumeResourceProvider implements pulumi.dynamic.ResourceProvider {
	/**
	 * Validates inputs at plan time. A relative `mountPath` would otherwise
	 * fail deep inside `volumeCreate` with an opaque GraphQL error.
	 */
	async check(
		_olds: VolumeInputs,
		news: VolumeInputs,
	): Promise<pulumi.dynamic.CheckResult<VolumeInputs>> {
		const failures: pulumi.dynamic.CheckFailure[] = [];

		if (isResolvedString(news.mountPath) && !news.mountPath.startsWith("/")) {
			failures.push({
				property: "mountPath",
				reason: `mountPath must be an absolute path starting with "/", got "${news.mountPath}"`,
			});
		}

		return { inputs: news, failures };
	}

	async create(inputs: VolumeInputs): Promise<pulumi.dynamic.CreateResult> {
		const client = new Client(
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
		props: VolumeOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new Client(
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
			// The lookup itself errored (network hiccup, transient API failure,
			// eventual consistency) — we don't actually know whether the volume
			// still exists, so keep the existing state rather than reporting a
			// false deletion. This is distinct from a successful lookup that
			// finds no match, which means the volume is confirmed gone.
			pulumi.log.warn(
				`Railway volume refresh lookup failed; keeping existing state: ${String(error)}`,
			);

			return { id, props };
		}

		if (!volumeId) {
			// The lookup succeeded and found no matching volume instance —
			// confirmed gone (e.g. deleted via the dashboard). Blank state lets
			// refresh reconcile the deletion; create()'s adopt-or-create then
			// recreates it on the next `up` if the resource is still declared.
			return {};
		}

		return { id: volumeId, props: { ...props, volumeId } };
	}

	async delete(id: string, props: VolumeOutputs): Promise<void> {
		const client = new Client(
			resolveCredential(props.token, props.tokenEnvVar),
		);

		try {
			await client.query(VOLUME_DELETE, { volumeId: id });
		} catch (error) {
			// Already gone — deletion is idempotent.
			if (isGraphqlNotFoundError(error)) {
				pulumi.log.warn(`Railway volume "${id}" already deleted`);

				return;
			}

			throw error;
		}
	}

	async diff(
		_id: string,
		olds: VolumeOutputs,
		news: VolumeInputs,
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
class VolumeResource extends pulumi.dynamic.Resource {
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
			new VolumeResourceProvider(),
			name,
			{ ...args, volumeId: undefined },
			// The API token flows into dynamic-provider state with the outputs — mark it secret there.
			{ ...opts, additionalSecretOutputs: ["token"] },
		);
	}
}

/** Options type for Volume — replaces Pulumi's native `provider` field. */
type VolumeOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Railway authentication context. */
	provider: Provider;

	/** Railway project context. */
	project: Project;

	/** Railway environment context. */
	environment: Environment;

	/** Railway service context. */
	service: Service;
};

/** Args for Volume. */
export interface VolumeArgs {
	/** Absolute path inside the container where the volume is mounted. */
	mountPath: pulumi.Input<string>;
}

/**
 * Manages a Railway persistent volume with adopt-or-create semantics.
 *
 * @example
 * ```typescript
 * new railway.Volume("api-data", {
 *   mountPath: "/data",
 * }, { provider, project, environment, service });
 * ```
 */
export class Volume extends pulumi.ComponentResource {
	constructor(name: string, args: VolumeArgs, opts: VolumeOptions) {
		const { provider, project, environment, service, ...pulumiOpts } = opts;

		super("infracraft:railway:Volume", name, {}, pulumiOpts);

		new VolumeResource(
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
			// Volume would silently never reach the actual cloud volume.
			pulumi.mergeOptions(pulumiOpts, { parent: this }),
		);

		this.registerOutputs({});
	}
}
