import * as pulumi from "@pulumi/pulumi";
import { RailwayClient } from "./client";
import type { RailwayProject } from "./project";
import type { RailwayProvider } from "./provider";

/** Resolved inputs for the Railway environment dynamic provider. */
interface RailwayEnvironmentInputs {
	/** Railway API bearer token. */
	token: string;

	/** Railway project UUID. */
	projectId: string;

	/** Environment display name (e.g. `"production"`, `"staging"`). */
	name: string;

	/** Name of an existing environment to fork from when creating a new one. */
	source?: string;
}

/** Persisted state for the Railway environment. */
interface RailwayEnvironmentOutputs extends RailwayEnvironmentInputs {
	/** Railway-assigned environment UUID. */
	environmentId: string;
}

const ENVIRONMENT_CREATE_MUTATION = `
  mutation EnvironmentCreate($input: EnvironmentCreateInput!) {
    environmentCreate(input: $input) {
      id
      name
    }
  }
`;

const ENVIRONMENT_DELETE_MUTATION = `
  mutation($id: String!) { environmentDelete(id: $id) }
`;

const PROJECT_ENVIRONMENTS_QUERY = `
  query($projectId: String!) {
    project(id: $projectId) {
      environments {
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

/**
 * Queries a project's environments and resolves the ID for the given name.
 */
async function findEnvironmentId(
	client: RailwayClient,
	projectId: string,
	name: string,
): Promise<string | undefined> {
	const result = await client.query<{
		project: {
			environments: {
				edges: Array<{ node: { id: string; name: string } }>;
			};
		};
	}>(PROJECT_ENVIRONMENTS_QUERY, { projectId });

	const match = result.project.environments.edges.find(
		(edge) => edge.node.name === name,
	);

	return match?.node.id;
}

/**
 * Dynamic provider that resolves or creates a Railway environment by name.
 *
 * @internal Exported only for unit testing; not part of the public API surface.
 */
export class RailwayEnvironmentResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
	/**
	 * Adopts an existing Railway environment when found by name, or creates a new
	 * one (optionally forked from a source environment) when not found.
	 *
	 * @param inputs Resolved provider inputs including token, projectId, name, and optional source.
	 * @returns Pulumi dynamic create result with the environment UUID as the resource ID.
	 * @throws {Error} When `source` is provided but cannot be resolved to an environment ID.
	 */
	async create(
		inputs: RailwayEnvironmentInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		const client = new RailwayClient(inputs.token);

		let environmentId = await findEnvironmentId(
			client,
			inputs.projectId,
			inputs.name,
		);

		if (environmentId) {
			pulumi.log.info(
				`Adopting existing Railway environment "${inputs.name}" (${environmentId})`,
			);
		} else {
			let sourceEnvironmentId: string | undefined;

			if (inputs.source) {
				sourceEnvironmentId = await findEnvironmentId(
					client,
					inputs.projectId,
					inputs.source,
				);

				if (!sourceEnvironmentId) {
					throw new Error(
						`Railway source environment "${inputs.source}" not found in project ${inputs.projectId}`,
					);
				}
			}

			const result = await client.query<{
				environmentCreate: { id: string; name: string };
			}>(ENVIRONMENT_CREATE_MUTATION, {
				input: {
					projectId: inputs.projectId,
					name: inputs.name,
					// skipInitialDeploys: hold deploys so a forked env doesn't run with inherited
					// source/production variables before our RailwayVariable resources overwrite them.
					skipInitialDeploys: true,
					...(sourceEnvironmentId ? { sourceEnvironmentId } : {}),
				},
			});

			environmentId = result.environmentCreate.id;

			pulumi.log.info(
				`Created Railway environment "${inputs.name}" (${environmentId})`,
			);
		}

		const outs: RailwayEnvironmentOutputs = { ...inputs, environmentId };

		return { id: environmentId, outs };
	}

	async read(
		_id: string,
		props: RailwayEnvironmentOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new RailwayClient(props.token);

		const environmentId = await findEnvironmentId(
			client,
			props.projectId,
			props.name,
		);

		if (!environmentId) {
			// Resource gone → blank id lets refresh reconcile the deletion.
			return {};
		}

		return { id: environmentId, props: { ...props, environmentId } };
	}

	async update(
		_id: string,
		_olds: RailwayEnvironmentOutputs,
		news: RailwayEnvironmentInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		const client = new RailwayClient(news.token);

		const environmentId = await findEnvironmentId(
			client,
			news.projectId,
			news.name,
		);

		if (!environmentId) {
			throw new Error(
				`Railway environment "${news.name}" not found in project ${news.projectId}`,
			);
		}

		return { outs: { ...news, environmentId } };
	}

	/**
	 * Deletes the environment (which cascades its per-environment service instances).
	 * Protection of the shared production environment is the consumer's responsibility
	 * via the `protect` resource option, not provider logic.
	 */
	async delete(_id: string, props: RailwayEnvironmentOutputs): Promise<void> {
		const client = new RailwayClient(props.token);

		try {
			await client.query(ENVIRONMENT_DELETE_MUTATION, {
				id: props.environmentId,
			});

			pulumi.log.info(
				`Deleted Railway environment "${props.name}" (${props.environmentId})`,
			);
		} catch {
			pulumi.log.warn(
				`Failed to delete Railway environment "${props.name}" (may already be deleted)`,
			);
		}
	}

	async diff(
		_id: string,
		olds: RailwayEnvironmentOutputs,
		news: RailwayEnvironmentInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.projectId !== news.projectId) {
			replaces.push("projectId");
		}

		if (olds.name !== news.name) {
			replaces.push("name");
		}

		return {
			changes: replaces.length > 0,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/** Internal dynamic resource — not part of the public API. */
class RailwayEnvironmentResource extends pulumi.dynamic.Resource {
	public declare readonly environmentId: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			token: pulumi.Input<string>;
			projectId: pulumi.Input<string>;
			name: pulumi.Input<string>;
			source?: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new RailwayEnvironmentResourceProvider(),
			name,
			{
				...args,
				environmentId: undefined,
			},
			// The API token flows into dynamic-provider state with the outputs — mark it secret there.
			{ ...opts, additionalSecretOutputs: ["token"] },
		);
	}
}

/** Options type for RailwayEnvironment — replaces Pulumi's native `provider` field. */
type RailwayEnvironmentOptions = Omit<
	pulumi.ComponentResourceOptions,
	"provider"
> & {
	/** Railway authentication context. */
	provider: RailwayProvider;

	/** Railway project context to resolve the environment from. */
	project: RailwayProject;
};

/** Args for RailwayEnvironment. */
export interface RailwayEnvironmentArgs {
	/** Environment display name (e.g. `"production"`, `"staging"`). */
	name: pulumi.Input<string>;

	/**
	 * Name of an existing environment to fork from when this environment is created.
	 * Evaluated only at creation time — changing `source` after the environment exists
	 * has no effect (an existing environment is never re-forked).
	 * Maps to `EnvironmentCreateInput.sourceEnvironmentId` after name → ID resolution.
	 */
	source?: pulumi.Input<string>;
}

/**
 * Resolves or creates a Railway environment by name within a project.
 *
 * When the named environment already exists it is adopted (no mutation).
 * When it does not exist it is created — optionally forked from a source
 * environment so the new env inherits service instances and variables.
 *
 * @example
 * ```typescript
 * // Adopt or create "production" (no source)
 * const production = new RailwayEnvironment("production", {
 *   name: "production",
 * }, { provider, project });
 *
 * // Adopt or create "staging", forked from "production"
 * const staging = new RailwayEnvironment("staging", {
 *   name: "staging",
 *   source: "production",
 * }, { provider, project });
 *
 * // Use environmentId downstream
 * const service = new RailwayService("api", { name: "api" }, {
 *   provider, project, environment: staging,
 * });
 * ```
 */
export class RailwayEnvironment extends pulumi.ComponentResource {
	/** Railway environment UUID. */
	public readonly id: pulumi.Output<string>;

	constructor(
		name: string,
		args: RailwayEnvironmentArgs,
		opts: RailwayEnvironmentOptions,
	) {
		const { provider, project, ...pulumiOpts } = opts;

		super("infracraft:railway:Environment", name, {}, pulumiOpts);

		const resource = new RailwayEnvironmentResource(
			`${name}-resource`,
			{
				token: provider.token,
				projectId: project.id,
				name: args.name,
				source: args.source,
			},
			{ parent: this },
		);

		this.id = resource.environmentId;

		this.registerOutputs({ id: this.id });
	}
}
