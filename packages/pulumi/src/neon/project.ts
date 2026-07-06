import * as pulumi from "@pulumi/pulumi";
import { isResolvedString } from "../dynamic/is-resolved-string";
import { resolveCredential } from "../dynamic/resolve-credential";
import { ApiNotFoundError } from "../errors/api-not-found-error";
import { NeonClient } from "./client";
import type { NeonProvider } from "./provider";

/** Resolved inputs for the Neon project dynamic provider. */
interface NeonProjectInputs {
	/** Neon API key. Absent when `apiKeyEnvVar` is used instead. */
	apiKey?: string;

	/** Env var name resolved to the API key when `apiKey` is absent (see `NeonProviderArgs.apiKeyEnvVar`). */
	apiKeyEnvVar?: string;

	/** Exact project display name to adopt or create. */
	name: string;

	/** Optional Neon organization ID to scope the project search. */
	orgId?: string;
}

/** Persisted state for the Neon project. */
interface NeonProjectOutputs extends NeonProjectInputs {
	/** Neon-assigned project ID (e.g. `"quiet-forest-69719462"`). */
	projectId: string;
}

/** Neon API response for listing projects. */
interface ProjectListResponse {
	projects: Array<{ id: string; name: string }>;
}

/** Neon API response for project creation. */
interface ProjectCreateResponse {
	project: { id: string; name: string };
}

/** Neon API response for reading a single project. */
interface ProjectReadResponse {
	project: { id: string; name: string };
}

/**
 * Dynamic provider implementing adopt-or-create for Neon projects.
 *
 * On `create()`, queries `GET /projects` and performs an exact name match.
 * If found, adopts the existing project. If not, creates a new one via
 * `POST /projects`. Deletion is a no-op to protect production databases.
 *
 * @internal Exported only for unit testing; not part of the public API surface.
 */
export class NeonProjectResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
	/**
	 * Validates inputs at plan time. An empty project name would otherwise
	 * fail deep inside the Neon API call — and never match on the adopt lookup.
	 */
	async check(
		_olds: NeonProjectInputs,
		news: NeonProjectInputs,
	): Promise<pulumi.dynamic.CheckResult<NeonProjectInputs>> {
		const failures: pulumi.dynamic.CheckFailure[] = [];

		if (isResolvedString(news.name) && news.name.trim().length === 0) {
			failures.push({
				property: "name",
				reason: 'name must be a non-empty project name (e.g. "my-app")',
			});
		}

		return { inputs: news, failures };
	}

	async create(
		inputs: NeonProjectInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		const client = new NeonClient(
			resolveCredential(inputs.apiKey, inputs.apiKeyEnvVar),
		);

		const query = inputs.orgId
			? `/projects?org_id=${inputs.orgId}&search=${encodeURIComponent(inputs.name)}`
			: "/projects";

		const result = await client.get<ProjectListResponse>(query);

		const existing = result.projects.find((p) => p.name === inputs.name);

		let projectId: string;

		if (existing) {
			pulumi.log.info(
				`Adopting existing Neon project "${inputs.name}" (${existing.id})`,
			);

			projectId = existing.id;
		} else {
			pulumi.log.info(`Neon project "${inputs.name}" not found — creating...`);

			const created = await client.post<ProjectCreateResponse>("/projects", {
				project: { name: inputs.name },
			});

			projectId = created.project.id;
		}

		const outs: NeonProjectOutputs = { ...inputs, projectId };

		return { id: projectId, outs };
	}

	async read(
		id: string,
		props: NeonProjectOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new NeonClient(
			resolveCredential(props.apiKey, props.apiKeyEnvVar),
		);

		try {
			const result = await client.get<ProjectReadResponse>(`/projects/${id}`);

			return {
				id: result.project.id,
				props: {
					...props,
					name: result.project.name,
					projectId: result.project.id,
				},
			};
		} catch (error) {
			// Resource gone → blank id lets refresh reconcile the deletion.
			if (error instanceof ApiNotFoundError) {
				return {};
			}

			throw error;
		}
	}

	async update(
		id: string,
		_olds: NeonProjectOutputs,
		news: NeonProjectInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		const client = new NeonClient(
			resolveCredential(news.apiKey, news.apiKeyEnvVar),
		);

		await client.patch(`/projects/${id}`, {
			project: { name: news.name },
		});

		return { outs: { ...news, projectId: id } };
	}

	async delete(): Promise<void> {
		pulumi.log.warn(
			"Neon project deletion skipped — projects are not deleted by Pulumi",
		);
	}

	async diff(
		_id: string,
		olds: NeonProjectOutputs,
		news: NeonProjectInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];
		const changes: string[] = [];

		if (olds.name !== news.name) {
			changes.push("name");
		}

		if (olds.orgId !== news.orgId) {
			replaces.push("orgId");
		}

		return {
			changes: replaces.length > 0 || changes.length > 0,
			replaces,
			// projectId survives every in-place update (only orgId replaces), so
			// dependents keep a known projectId during preview.
			stables: replaces.length === 0 ? ["projectId"] : [],
			deleteBeforeReplace: true,
		};
	}
}

/** Internal dynamic resource — not part of the public API. */
class NeonProjectResource extends pulumi.dynamic.Resource {
	public declare readonly projectId: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			apiKey?: pulumi.Input<string>;
			apiKeyEnvVar?: pulumi.Input<string>;
			name: pulumi.Input<string>;
			orgId?: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new NeonProjectResourceProvider(),
			name,
			{ ...args, projectId: undefined },
			// The API key flows into dynamic-provider state with the outputs — mark it secret there.
			{ ...opts, additionalSecretOutputs: ["apiKey"] },
		);
	}
}

/** Options type for NeonProject — replaces Pulumi's native `provider` field. */
type NeonProjectOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Neon authentication context. */
	provider: NeonProvider;
};

/** Args for NeonProject. */
export interface NeonProjectArgs {
	/** Exact project display name to adopt or create. */
	name: pulumi.Input<string>;
}

/**
 * Manages a Neon project with adopt-or-create semantics.
 *
 * @example
 * ```typescript
 * const project = new NeonProject("db", {
 *   name: "my-app",
 * }, { provider });
 *
 * const branch = new NeonBranch("production", {
 *   name: "production",
 * }, { provider, project });
 * ```
 */
export class NeonProject extends pulumi.ComponentResource {
	/** Neon-assigned project ID. */
	public readonly id: pulumi.Output<string>;

	constructor(name: string, args: NeonProjectArgs, opts: NeonProjectOptions) {
		const { provider, ...pulumiOpts } = opts;

		super("infracraft:neon:Project", name, {}, pulumiOpts);

		const resource = new NeonProjectResource(
			`${name}-resource`,
			{
				apiKey: provider.apiKey,
				apiKeyEnvVar: provider.apiKeyEnvVar,
				name: args.name,
				orgId: provider.orgId,
			},
			{ parent: this },
		);

		this.id = resource.projectId;

		this.registerOutputs({ id: this.id });
	}
}
