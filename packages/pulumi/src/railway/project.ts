import * as pulumi from "@pulumi/pulumi";
import { RailwayClient } from "./client";
import type { RailwayProvider } from "./provider";

/** Resolved inputs for the Railway project dynamic provider. */
interface RailwayProjectInputs {
	/** Railway API bearer token. */
	token: string;

	/** Desired display name for the project in Railway's dashboard. */
	name: string;

	/** Optional description shown in Railway's dashboard. */
	description?: string;
}

/** Persisted state for the Railway project. */
interface RailwayProjectOutputs extends RailwayProjectInputs {
	/** Railway-assigned project UUID. */
	projectId: string;

	/** Railway-assigned production environment UUID. */
	productionEnvironmentId: string;
}

const WORKSPACE_QUERY = `
  query {
    me {
      workspaces {
        id
        name
        projects {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    }
  }
`;

const PROJECT_CREATE = `
  mutation($input: ProjectCreateInput!) {
    projectCreate(input: $input) {
      id
      name
    }
  }
`;

const PROJECT_UPDATE = `
  mutation($id: String!, $input: ProjectUpdateInput!) {
    projectUpdate(id: $id, input: $input) {
      id
      name
    }
  }
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
 * Fetches all environments for a project and returns a name → UUID map.
 */
async function fetchProjectEnvironments(
	client: RailwayClient,
	projectId: string,
): Promise<Record<string, string>> {
	const result = await client.query<{
		project: {
			environments: {
				edges: Array<{ node: { id: string; name: string } }>;
			};
		};
	}>(PROJECT_ENVIRONMENTS_QUERY, { projectId });

	const environments: Record<string, string> = {};

	for (const edge of result.project.environments.edges) {
		environments[edge.node.name] = edge.node.id;
	}

	return environments;
}

/**
 * Dynamic provider that adopts an existing Railway project by name, or creates one.
 *
 * On create:
 * 1. Queries workspaces to find the project by name.
 * 2. If found → adopts. If not → creates via `projectCreate`.
 * 3. Fetches all environments and resolves the production environment ID.
 *
 * Deletion is a no-op (with a warning) to prevent accidental project removal.
 * Name changes trigger replacement.
 */
class RailwayProjectResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
	async create(
		inputs: RailwayProjectInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		const client = new RailwayClient(inputs.token);

		const workspaceResult = await client.query<{
			me: {
				workspaces: Array<{
					id: string;
					name: string;
					projects: {
						edges: Array<{ node: { id: string; name: string } }>;
					};
				}>;
			};
		}>(WORKSPACE_QUERY);

		const workspaces = workspaceResult.me.workspaces;

		if (workspaces.length === 0) {
			throw new Error("No Railway workspace found — cannot create project");
		}

		let projectId: string | undefined;

		for (const workspace of workspaces) {
			const match = workspace.projects.edges.find(
				(edge) => edge.node.name === inputs.name,
			);

			if (match) {
				projectId = match.node.id;

				break;
			}
		}

		if (projectId) {
			pulumi.log.info(
				`Adopted existing Railway project "${inputs.name}" (${projectId})`,
			);

			if (inputs.description) {
				await client.query(PROJECT_UPDATE, {
					id: projectId,
					input: { description: inputs.description },
				});
			}
		} else {
			const workspace = workspaces[0];

			const created = await client.query<{
				projectCreate: { id: string; name: string };
			}>(PROJECT_CREATE, {
				input: {
					name: inputs.name,
					description: inputs.description,
					workspaceId: workspace.id,
				},
			});

			projectId = created.projectCreate.id;

			pulumi.log.info(
				`Created Railway project "${inputs.name}" (${projectId})`,
			);
		}

		if (!projectId) {
			throw new Error(
				`Failed to find or create Railway project "${inputs.name}"`,
			);
		}

		const environments = await fetchProjectEnvironments(client, projectId);

		const productionEnvironmentId = environments.production ?? "";

		const outs: RailwayProjectOutputs = {
			...inputs,
			projectId,
			productionEnvironmentId,
		};

		return { id: projectId, outs };
	}

	async update(
		id: string,
		_olds: RailwayProjectOutputs,
		news: RailwayProjectInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		const client = new RailwayClient(news.token);

		await client.query(PROJECT_UPDATE, {
			id,
			input: { name: news.name, description: news.description },
		});

		const environments = await fetchProjectEnvironments(client, id);

		const productionEnvironmentId = environments.production ?? "";

		const outs: RailwayProjectOutputs = {
			...news,
			projectId: id,
			productionEnvironmentId,
		};

		return { outs };
	}

	async read(
		id: string,
		props: RailwayProjectOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new RailwayClient(props.token);

		const environments = await fetchProjectEnvironments(client, id);

		const productionEnvironmentId =
			environments.production ?? props.productionEnvironmentId;

		return {
			id,
			props: { ...props, projectId: id, productionEnvironmentId },
		};
	}

	async delete(): Promise<void> {
		pulumi.log.warn(
			"Railway project deletion skipped — projects are not deleted by Pulumi",
		);
	}

	async diff(
		_id: string,
		olds: RailwayProjectOutputs,
		news: RailwayProjectInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];
		const changes: string[] = [];

		if (olds.name !== news.name) {
			changes.push("name");
		}

		if (olds.description !== news.description) {
			changes.push("description");
		}

		return {
			changes: replaces.length > 0 || changes.length > 0,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/** Internal dynamic resource — not part of the public API. */
class RailwayProjectResource extends pulumi.dynamic.Resource {
	public declare readonly projectId: pulumi.Output<string>;
	public declare readonly productionEnvironmentId: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			token: pulumi.Input<string>;
			name: pulumi.Input<string>;
			description?: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new RailwayProjectResourceProvider(),
			name,
			{
				...args,
				projectId: undefined,
				productionEnvironmentId: undefined,
			},
			opts,
		);
	}
}

/** Options type for RailwayProject — replaces Pulumi's native `provider` field. */
type RailwayProjectOptions = Omit<
	pulumi.ComponentResourceOptions,
	"provider"
> & {
	/** Railway authentication context. */
	provider: RailwayProvider;
};

/** Args for RailwayProject. */
export interface RailwayProjectArgs {
	/** Project display name to find and adopt or create. */
	name: pulumi.Input<string>;

	/** Optional description shown in Railway's dashboard. */
	description?: pulumi.Input<string>;
}

/**
 * Manages a Railway project with adopt-or-create semantics.
 *
 * Discovers or creates the project and resolves the production environment ID.
 * Deploy tokens are provisioned separately via {@link RailwayProjectToken} so
 * each environment gets its own correctly-scoped token with no cross-stack collisions.
 *
 * @example
 * ```typescript
 * const project = new RailwayProject("my-project", {
 *   name: "my-app",
 *   description: "Railway services for my-app",
 * }, { provider });
 *
 * // Use outputs downstream
 * const environment = new RailwayEnvironment("production", {
 *   name: "production",
 * }, { provider, project });
 * ```
 */
export class RailwayProject extends pulumi.ComponentResource {
	/** Railway project UUID. */
	public readonly id: pulumi.Output<string>;

	constructor(
		name: string,
		args: RailwayProjectArgs,
		opts: RailwayProjectOptions,
	) {
		const { provider, ...pulumiOpts } = opts;

		super("infracraft:railway:Project", name, {}, pulumiOpts);

		const resource = new RailwayProjectResource(
			`${name}-resource`,
			{
				token: provider.token,
				name: args.name,
				description: args.description,
			},
			{ parent: this },
		);

		this.id = resource.projectId;

		this.registerOutputs({ id: this.id });
	}
}
