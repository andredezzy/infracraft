import * as pulumi from "@pulumi/pulumi";
import { isResolvedString } from "../dynamic/is-resolved-string";
import { resolveCredential } from "../dynamic/resolve-credential";
import { ApiNotFoundError } from "../errors/api-not-found-error";
import { Client } from "./client";
import type { Provider } from "./provider";

/** Resolved inputs for the Neon project dynamic provider. */
interface ProjectInputs {
	/** Neon API key. Absent when `apiKeyEnvVar` is used instead. */
	apiKey?: string;

	/** Env var name resolved to the API key when `apiKey` is absent (see `ProviderArgs.apiKeyEnvVar`). */
	apiKeyEnvVar?: string;

	/** Exact project display name to adopt or create. */
	name: string;

	/** Optional Neon organization ID to scope the project search. */
	orgId?: string;
}

/** Persisted state for the Neon project. */
interface ProjectOutputs extends ProjectInputs {
	/** Neon-assigned project ID (e.g. `"quiet-forest-69719462"`). */
	projectId: string;
}

/** Neon API response for listing projects, with cursor-pagination info. */
interface ProjectListResponse {
	projects: Array<{ id: string; name: string }>;
	pagination?: { cursor?: string };
}

/** Safety bound on pagination follow-through — a genuinely wedged cursor must fail loudly, not hang forever. */
const MAX_PROJECT_LIST_PAGES = 100;

/**
 * Finds a Neon project by exact name, following cursor pagination across
 * `GET /projects` until a match is found or the account's projects are
 * exhausted. Without `?search=<name>`, the endpoint's default page size (10)
 * silently misses any project beyond the first page — Neon's `search` is a
 * substring match, not exact, so an exact-name check still runs client-side.
 */
async function findProjectByName(
	client: Client,
	name: string,
	orgId?: string,
): Promise<string | undefined> {
	let cursor: string | undefined;

	for (let page = 0; page < MAX_PROJECT_LIST_PAGES; page++) {
		const params = new URLSearchParams({ search: name });

		if (orgId) {
			params.set("org_id", orgId);
		}

		if (cursor) {
			params.set("cursor", cursor);
		}

		const result = await client.get<ProjectListResponse>(
			`/projects?${params.toString()}`,
		);

		const match = result.projects.find((p) => p.name === name);

		if (match) {
			return match.id;
		}

		if (result.projects.length === 0 || !result.pagination?.cursor) {
			return undefined;
		}

		cursor = result.pagination.cursor;
	}

	throw new Error(
		`Neon project search for "${name}" did not converge after ${MAX_PROJECT_LIST_PAGES} pages — the account may have an unexpectedly large number of projects, or Neon's pagination cursor is not advancing.`,
	);
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
export class ProjectResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
	/**
	 * Validates inputs at plan time. An empty project name would otherwise
	 * fail deep inside the Neon API call — and never match on the adopt lookup.
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
			resolveCredential(inputs.apiKey, inputs.apiKeyEnvVar),
		);

		const existingId = await findProjectByName(
			client,
			inputs.name,
			inputs.orgId,
		);

		let projectId: string;

		if (existingId) {
			pulumi.log.info(
				`Adopting existing Neon project "${inputs.name}" (${existingId})`,
			);

			projectId = existingId;
		} else {
			pulumi.log.info(`Neon project "${inputs.name}" not found — creating...`);

			const created = await client.post<ProjectCreateResponse>("/projects", {
				project: { name: inputs.name },
			});

			projectId = created.project.id;
		}

		const outs: ProjectOutputs = { ...inputs, projectId };

		return { id: projectId, outs };
	}

	async read(
		id: string,
		props: ProjectOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new Client(
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
		_olds: ProjectOutputs,
		news: ProjectInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		const client = new Client(
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
		olds: ProjectOutputs,
		news: ProjectInputs,
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
class ProjectResource extends pulumi.dynamic.Resource {
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
			new ProjectResourceProvider(),
			name,
			{ ...args, projectId: undefined },
			// The API key flows into dynamic-provider state with the outputs — mark it secret there.
			{ ...opts, additionalSecretOutputs: ["apiKey"] },
		);
	}
}

/** Options type for Project — replaces Pulumi's native `provider` field. */
type ProjectOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Neon authentication context. */
	provider: Provider;
};

/** Args for Project. */
export interface ProjectArgs {
	/** Exact project display name to adopt or create. */
	name: pulumi.Input<string>;
}

/**
 * Manages a Neon project with adopt-or-create semantics.
 *
 * @example
 * ```typescript
 * const project = new neon.Project("db", {
 *   name: "my-app",
 * }, { provider });
 *
 * const branch = new neon.Branch("production", {
 *   name: "production",
 * }, { provider, project });
 * ```
 */
export class Project extends pulumi.ComponentResource {
	/** Neon-assigned project ID. */
	public readonly id: pulumi.Output<string>;

	constructor(name: string, args: ProjectArgs, opts: ProjectOptions) {
		const { provider, ...pulumiOpts } = opts;

		super("infracraft:neon:Project", name, {}, pulumiOpts);

		const resource = new ProjectResource(
			`${name}-resource`,
			{
				apiKey: provider.apiKey,
				apiKeyEnvVar: provider.apiKeyEnvVar,
				name: args.name,
				orgId: provider.orgId,
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
