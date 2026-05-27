import * as pulumi from "@pulumi/pulumi";
import { NeonClient } from "./client.js";

/** Resolved inputs for the Neon project dynamic provider. */
export interface NeonProjectInputs {
	/** Neon API key. */
	apiKey: string;

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
 */
class NeonProjectProvider implements pulumi.dynamic.ResourceProvider {
	/**
	 * Creates or adopts a Neon project by name.
	 *
	 * @param inputs Resolved project configuration
	 * @returns The Neon project ID as the resource ID
	 */
	async create(
		inputs: NeonProjectInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		const client = new NeonClient(inputs.apiKey);

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

	/**
	 * Reads current state for `pulumi refresh`.
	 *
	 * @param id Current Neon project ID
	 * @param props Last known persisted state
	 * @returns Refreshed resource ID and properties
	 * @throws {Error} If the project no longer exists
	 */
	async read(
		id: string,
		props: NeonProjectOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new NeonClient(props.apiKey);

		const result = await client.get<ProjectReadResponse>(`/projects/${id}`);

		return {
			id: result.project.id,
			props: {
				...props,
				name: result.project.name,
				projectId: result.project.id,
			},
		};
	}

	/**
	 * Skips deletion to protect production databases.
	 */
	async delete(): Promise<void> {
		pulumi.log.warn(
			"Neon project deletion skipped — projects are not deleted by Pulumi",
		);
	}

	/**
	 * Compares old and new inputs. `name` or `orgId` changes trigger replacement.
	 */
	async diff(
		_id: string,
		olds: NeonProjectOutputs,
		news: NeonProjectInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.name !== news.name) {
			replaces.push("name");
		}

		if (olds.orgId !== news.orgId) {
			replaces.push("orgId");
		}

		return {
			changes: replaces.length > 0,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/**
 * Manages a Neon project with adopt-or-create semantics.
 *
 * Discovers or creates the project by exact name match. Deletion is a no-op
 * to prevent accidental removal of production databases.
 *
 * @example
 * ```typescript
 * const project = new NeonProject("neon-project", {
 *   apiKey: config.requireSecret("neonApiKey"),
 *   name: "my-app",
 *   orgId: "org-abc123",
 * });
 *
 * // Use the resolved project ID downstream
 * const branch = new NeonBranch("neon-branch-production", {
 *   apiKey: config.requireSecret("neonApiKey"),
 *   projectId: project.projectId,
 *   name: "production",
 * });
 * ```
 */
export class NeonProject extends pulumi.dynamic.Resource {
	/** Neon-assigned project ID. */
	public declare readonly projectId: pulumi.Output<string>;

	/**
	 * @param name Pulumi resource name
	 * @param args Project configuration inputs
	 * @param opts Standard Pulumi resource options
	 */
	constructor(
		name: string,
		args: {
			/** Neon API key. */
			apiKey: pulumi.Input<string>;

			/** Exact project display name to adopt or create. */
			name: pulumi.Input<string>;

			/** Optional Neon organization ID to scope the project search. */
			orgId?: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new NeonProjectProvider(),
			name,
			{ ...args, projectId: undefined },
			opts,
		);
	}
}
