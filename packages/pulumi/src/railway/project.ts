import * as pulumi from "@pulumi/pulumi";
import { RailwayClient } from "./client.js";

/** Resolved inputs for the Railway project dynamic provider. */
export interface RailwayProjectInputs {
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

	/** Railway project-scoped token (auto-provisioned, exposed as secret output). */
	projectToken: string;
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

const PROJECT_TOKENS_QUERY = `
  query($projectId: String!) {
    projectTokens(projectId: $projectId) {
      edges { node { id name } }
    }
  }
`;

const PROJECT_TOKEN_CREATE = `
  mutation($input: ProjectTokenCreateInput!) {
    projectTokenCreate(input: $input)
  }
`;

const PROJECT_TOKEN_DELETE = `
  mutation($id: String!) { projectTokenDelete(id: $id) }
`;

const PERMANENT_TOKEN_NAME = "pulumi";

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
 * Gets or creates a permanent project-scoped token named "pulumi".
 *
 * Deletes any stale tokens with the same name before creating a new one,
 * ensuring a single canonical token exists. Does NOT write to Pulumi config —
 * the token is returned as a secret output for the consumer to manage.
 */
async function getOrCreateProjectToken(
	client: RailwayClient,
	projectId: string,
	environmentId?: string,
): Promise<string> {
	const tokensResult = await client.query<{
		projectTokens: {
			edges: Array<{ node: { id: string; name: string } }>;
		};
	}>(PROJECT_TOKENS_QUERY, { projectId });

	const stale = tokensResult.projectTokens.edges.filter(
		(edge) => edge.node.name === PERMANENT_TOKEN_NAME,
	);

	for (const entry of stale) {
		await client.query(PROJECT_TOKEN_DELETE, { id: entry.node.id });
	}

	const result = await client.query<{ projectTokenCreate: string }>(
		PROJECT_TOKEN_CREATE,
		{
			input: {
				projectId,
				name: PERMANENT_TOKEN_NAME,
				...(environmentId ? { environmentId } : {}),
			},
		},
	);

	return result.projectTokenCreate;
}

/**
 * Dynamic provider that adopts an existing Railway project by name, or creates one.
 *
 * On create:
 * 1. Queries workspaces to find the project by name.
 * 2. If found → adopts. If not → creates via `projectCreate`.
 * 3. Fetches all environments and resolves the production environment ID.
 * 4. Creates/reuses a project-scoped token named "pulumi".
 *
 * Deletion is a no-op (with a warning) to prevent accidental project removal.
 * Name changes trigger replacement.
 */
class RailwayProjectProvider implements pulumi.dynamic.ResourceProvider {
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

		const projectToken = await getOrCreateProjectToken(
			client,
			projectId,
			productionEnvironmentId || undefined,
		);

		const outs: RailwayProjectOutputs = {
			...inputs,
			projectId,
			productionEnvironmentId,
			projectToken,
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

		const projectToken = await getOrCreateProjectToken(
			client,
			id,
			productionEnvironmentId || undefined,
		);

		const outs: RailwayProjectOutputs = {
			...news,
			projectId: id,
			productionEnvironmentId,
			projectToken,
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

/**
 * Manages a Railway project with adopt-or-create semantics.
 *
 * Discovers or creates the project, resolves the production environment ID,
 * and provisions a project-scoped token named "pulumi" for CLI deploys.
 * The token is exposed as a secret output — the consumer decides how to store it.
 *
 * @example
 * ```typescript
 * const project = new RailwayProject("railway-project", {
 *   token: railwayConfig.token,
 *   name: "my-app",
 *   description: "Railway services for my-app",
 * });
 *
 * // Use outputs downstream
 * const serviceVar = new RailwayVariable("...", {
 *   projectId: project.projectId,
 *   environmentId: project.productionEnvironmentId,
 *   ...
 * });
 * ```
 */
export class RailwayProject extends pulumi.dynamic.Resource {
	/** Railway project UUID. */
	public declare readonly projectId: pulumi.Output<string>;

	/** Railway production environment UUID. */
	public declare readonly productionEnvironmentId: pulumi.Output<string>;

	/** Railway project-scoped token (secret). */
	public declare readonly projectToken: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			/** Railway API bearer token. */
			token: pulumi.Input<string>;

			/** Project display name to find and adopt or create. */
			name: pulumi.Input<string>;

			/** Optional description shown in Railway's dashboard. */
			description?: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new RailwayProjectProvider(),
			name,
			{
				...args,
				projectId: undefined,
				productionEnvironmentId: undefined,
				projectToken: pulumi.secret(undefined as unknown as string),
			},
			opts,
		);
	}
}
