import * as pulumi from "@pulumi/pulumi";
import { isResolvedString } from "../dynamic/is-resolved-string";
import { resolveCredential } from "../dynamic/resolve-credential";
import { Client } from "./client";
import type { Provider } from "./provider";

/** Resolved inputs for the Railway project dynamic provider. */
interface ProjectInputs {
	/** Railway API bearer token. Absent when `tokenEnvVar` is used instead. */
	token?: string;

	/** Env var name resolved to the token when `token` is absent (see `ProviderArgs.tokenEnvVar`). */
	tokenEnvVar?: string;

	/** Desired display name for the project in Railway's dashboard. */
	name: string;

	/** Optional description shown in Railway's dashboard. */
	description?: string;
}

/** Persisted state for the Railway project. */
interface ProjectOutputs extends ProjectInputs {
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
	client: Client,
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
 *
 * @internal Exported only for unit testing; not part of the public API surface.
 */
export class ProjectResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
	/**
	 * Validates inputs at plan time. An empty project name would otherwise fail
	 * deep inside the Railway API call — and never match on the adopt lookup.
	 */
	async check(
		_olds: ProjectInputs,
		news: ProjectInputs,
	): Promise<pulumi.dynamic.CheckResult<ProjectInputs>> {
		const failures: pulumi.dynamic.CheckFailure[] = [];

		if (isResolvedString(news.name) && news.name.trim().length === 0) {
			failures.push({
				property: "name",
				reason: 'name must be a non-empty project name (e.g. "my-app")',
			});
		}

		return { inputs: news, failures };
	}

	async create(inputs: ProjectInputs): Promise<pulumi.dynamic.CreateResult> {
		const client = new Client(
			resolveCredential(inputs.token, inputs.tokenEnvVar),
		);

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

		const outs: ProjectOutputs = {
			...inputs,
			projectId,
			productionEnvironmentId,
		};

		return { id: projectId, outs };
	}

	async update(
		id: string,
		_olds: ProjectOutputs,
		news: ProjectInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		const client = new Client(resolveCredential(news.token, news.tokenEnvVar));

		await client.query(PROJECT_UPDATE, {
			id,
			input: { name: news.name, description: news.description },
		});

		const environments = await fetchProjectEnvironments(client, id);

		const productionEnvironmentId = environments.production ?? "";

		const outs: ProjectOutputs = {
			...news,
			projectId: id,
			productionEnvironmentId,
		};

		return { outs };
	}

	async read(
		id: string,
		props: ProjectOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new Client(
			resolveCredential(props.token, props.tokenEnvVar),
		);

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
		olds: ProjectOutputs,
		news: ProjectInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const changes: string[] = [];

		if (olds.name !== news.name) {
			changes.push("name");
		}

		if (olds.description !== news.description) {
			changes.push("description");
		}

		return {
			changes: changes.length > 0,
			replaces: [],
			// projectId survives every in-place update (nothing replaces this
			// resource), so dependents keep a known projectId during preview.
			// productionEnvironmentId is deliberately NOT declared stable — update()
			// re-resolves it from the live environment list.
			stables: ["projectId"],
			deleteBeforeReplace: true,
		};
	}
}

/** Internal dynamic resource — not part of the public API. */
class ProjectResource extends pulumi.dynamic.Resource {
	public declare readonly projectId: pulumi.Output<string>;
	public declare readonly productionEnvironmentId: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			token?: pulumi.Input<string>;
			tokenEnvVar?: pulumi.Input<string>;
			name: pulumi.Input<string>;
			description?: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new ProjectResourceProvider(),
			name,
			{
				...args,
				projectId: undefined,
				productionEnvironmentId: undefined,
			},
			// The API token flows into dynamic-provider state with the outputs — mark it secret there.
			{ ...opts, additionalSecretOutputs: ["token"] },
		);
	}
}

/** Options type for Project — replaces Pulumi's native `provider` field. */
type ProjectOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Railway authentication context. */
	provider: Provider;
};

/** Args for Project. */
export interface ProjectArgs {
	/** Project display name to find and adopt or create. */
	name: pulumi.Input<string>;

	/** Optional description shown in Railway's dashboard. */
	description?: pulumi.Input<string>;
}

/**
 * Manages a Railway project with adopt-or-create semantics.
 *
 * Discovers or creates the project and resolves the production environment ID.
 * Deploy tokens are provisioned separately via {@link ProjectToken} so
 * each environment gets its own correctly-scoped token with no cross-stack collisions.
 *
 * @example
 * ```typescript
 * const project = new railway.Project("my-project", {
 *   name: "my-app",
 *   description: "Railway services for my-app",
 * }, { provider });
 *
 * // Use outputs downstream
 * const environment = new railway.Environment("production", {
 *   name: "production",
 * }, { provider, project });
 * ```
 */
export class Project extends pulumi.ComponentResource {
	/** Railway project UUID. */
	public readonly id: pulumi.Output<string>;

	constructor(name: string, args: ProjectArgs, opts: ProjectOptions) {
		const { provider, ...pulumiOpts } = opts;

		super("infracraft:railway:Project", name, {}, pulumiOpts);

		const resource = new ProjectResource(
			`${name}-resource`,
			{
				token: provider.token,
				tokenEnvVar: provider.tokenEnvVar,
				name: args.name,
				description: args.description,
			},
			// Forward the consumer's resource options (e.g. `retainOnDelete`) to the
			// underlying resource — Pulumi auto-inherits provider/protect from the
			// parent component, but not everything else.
			pulumi.mergeOptions(pulumiOpts, { parent: this }),
		);

		this.id = resource.projectId;

		this.registerOutputs({ id: this.id });
	}
}
