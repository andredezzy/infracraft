import * as pulumi from "@pulumi/pulumi";
import { NeonClient } from "./client";
import type { NeonProject } from "./project";
import type { NeonProvider } from "./provider";

/** Resolved inputs for the Neon branch dynamic provider. */
export interface NeonBranchInputs {
	/** Neon API key. */
	apiKey: string;

	/** Neon project ID (e.g. `"quiet-forest-69719462"`). */
	projectId: string;

	/** Branch display name (e.g. `"production"`, `"development"`). */
	name: string;

	/**
	 * Parent branch NAME. Resolved to `parent_id` inside `create()` via
	 * `findBranchByName`. Omit for project-root branches.
	 */
	parentName?: string;
}

/** Persisted state for the Neon branch. */
interface NeonBranchOutputs extends NeonBranchInputs {}

/** Neon API response for a branch. */
interface BranchResponse {
	branch: {
		id: string;
		name: string;
		project_id: string;
	};
}

/** Neon API response for branch creation. */
interface BranchCreateResponse {
	branch: {
		id: string;
		name: string;
		project_id: string;
	};
}

/** Neon API response for listing branches. */
interface BranchListResponse {
	branches: Array<{
		id: string;
		name: string;
	}>;
}

/**
 * Finds an existing Neon branch by name within a project.
 */
async function findBranchByName(
	client: NeonClient,
	projectId: string,
	name: string,
): Promise<string | undefined> {
	const result = await client.get<BranchListResponse>(
		`/projects/${projectId}/branches`,
	);

	const match = result.branches.find((b) => b.name === name);

	return match?.id;
}

/**
 * Dynamic provider implementing CRUD for Neon branches.
 *
 * Uses adopt-or-create on `create()`: finds an existing branch by name
 * before creating a new one. When `parentName` is supplied, resolves it
 * to a `parent_id` and includes it in the POST body.
 */
/** @internal Exported only for unit testing; not part of the public API surface. */
export class NeonBranchResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
	async create(inputs: NeonBranchInputs): Promise<pulumi.dynamic.CreateResult> {
		const client = new NeonClient(inputs.apiKey);

		let branchId = await findBranchByName(
			client,
			inputs.projectId,
			inputs.name,
		);

		if (branchId) {
			if (inputs.parentName) {
				pulumi.log.warn(
					`Adopting existing Neon branch "${inputs.name}" — parentName "${inputs.parentName}" is ignored for adopted branches (existing lineage preserved).`,
				);
			} else {
				pulumi.log.info(
					`Adopting existing Neon branch "${inputs.name}" (${branchId})`,
				);
			}
		} else {
			const body: { branch: { name: string; parent_id?: string } } = {
				branch: { name: inputs.name },
			};

			if (inputs.parentName) {
				const parentId = await findBranchByName(
					client,
					inputs.projectId,
					inputs.parentName,
				);

				if (!parentId) {
					throw new Error(
						`Neon parent branch "${inputs.parentName}" not found in project ${inputs.projectId}`,
					);
				}

				body.branch.parent_id = parentId;
			}

			const result = await client.post<BranchCreateResponse>(
				`/projects/${inputs.projectId}/branches`,
				body,
			);

			branchId = result.branch.id;
		}

		return { id: branchId, outs: { ...inputs } };
	}

	async read(
		id: string,
		props: NeonBranchOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new NeonClient(props.apiKey);

		const result = await client.get<BranchResponse>(
			`/projects/${props.projectId}/branches/${id}`,
		);

		// parentName is preserved from prior state (props): the Neon API does not expose
		// a branch's parent on GET /branches/:id, so it cannot be re-derived here.
		return {
			id: result.branch.id,
			props: { ...props, name: result.branch.name },
		};
	}

	async delete(id: string, props: NeonBranchOutputs): Promise<void> {
		const client = new NeonClient(props.apiKey);

		try {
			await client.delete(`/projects/${props.projectId}/branches/${id}`);
		} catch {
			pulumi.log.warn(`Failed to delete Neon branch (may already be deleted)`);
		}
	}

	async diff(
		_id: string,
		olds: NeonBranchOutputs,
		news: NeonBranchInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];

		if (olds.projectId !== news.projectId) {
			replaces.push("projectId");
		}

		if (olds.parentName !== news.parentName) {
			replaces.push("parentName");
		}

		return {
			changes: replaces.length > 0 || olds.name !== news.name,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/** Internal dynamic resource — not part of the public API. */
class NeonBranchResource extends pulumi.dynamic.Resource {
	public declare readonly branchId: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			apiKey: pulumi.Input<string>;
			projectId: pulumi.Input<string>;
			name: pulumi.Input<string>;
			/** Name of the parent branch; omit for project-root branches. */
			parentName?: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(new NeonBranchResourceProvider(), name, { ...args }, opts);
	}
}

/** Options type for NeonBranch — replaces Pulumi's native `provider` field. */
type NeonBranchOptions = Omit<pulumi.ComponentResourceOptions, "provider"> & {
	/** Neon authentication context. */
	provider: NeonProvider;

	/** Neon project context. */
	project: NeonProject;
};

/** Args for NeonBranch. */
export interface NeonBranchArgs {
	/** Branch display name. */
	name: pulumi.Input<string>;

	/**
	 * Name of the parent branch to branch from (copy-on-write). Omit to
	 * branch from the project root (Neon default branch).
	 */
	parent?: pulumi.Input<string>;
}

/**
 * Manages a Neon branch with adopt-or-create semantics.
 *
 * @example
 * ```typescript
 * // Root branch (Neon default parent)
 * const production = new NeonBranch("production", {
 *   name: "production",
 * }, { provider, project });
 *
 * // Copy-on-write branch from production
 * const staging = new NeonBranch("staging", {
 *   name: "staging",
 *   parent: "production",
 * }, { provider, project });
 * ```
 */
export class NeonBranch extends pulumi.ComponentResource {
	/** Neon branch ID. */
	public readonly id: pulumi.Output<string>;

	constructor(name: string, args: NeonBranchArgs, opts: NeonBranchOptions) {
		const { provider, project, ...pulumiOpts } = opts;

		super("infracraft:neon:Branch", name, {}, pulumiOpts);

		const resource = new NeonBranchResource(
			`${name}-resource`,
			{
				apiKey: provider.apiKey,
				projectId: project.id,
				name: args.name,
				parentName: args.parent,
			},
			{ parent: this },
		);

		this.id = resource.id;

		this.registerOutputs({ id: this.id });
	}
}
