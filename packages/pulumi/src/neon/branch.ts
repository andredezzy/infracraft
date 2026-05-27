import * as pulumi from "@pulumi/pulumi";
import { NeonClient } from "./client.js";
import type { NeonProject } from "./project.js";
import type { NeonProvider } from "./provider.js";

/** Resolved inputs for the Neon branch dynamic provider. */
export interface NeonBranchInputs {
	/** Neon API key. */
	apiKey: string;

	/** Neon project ID (e.g. `"quiet-forest-69719462"`). */
	projectId: string;

	/** Branch display name (e.g. `"production"`, `"development"`). */
	name: string;
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
 * before creating a new one.
 */
class NeonBranchResourceProvider implements pulumi.dynamic.ResourceProvider {
	async create(inputs: NeonBranchInputs): Promise<pulumi.dynamic.CreateResult> {
		const client = new NeonClient(inputs.apiKey);

		let branchId = await findBranchByName(
			client,
			inputs.projectId,
			inputs.name,
		);

		if (branchId) {
			pulumi.log.info(
				`Adopting existing Neon branch "${inputs.name}" (${branchId})`,
			);
		} else {
			const result = await client.post<BranchCreateResponse>(
				`/projects/${inputs.projectId}/branches`,
				{ branch: { name: inputs.name } },
			);

			branchId = result.branch.id;
		}

		return { id: branchId, outs: inputs };
	}

	async read(
		id: string,
		props: NeonBranchOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new NeonClient(props.apiKey);

		const result = await client.get<BranchResponse>(
			`/projects/${props.projectId}/branches/${id}`,
		);

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
}

/**
 * Manages a Neon branch with adopt-or-create semantics.
 *
 * @example
 * ```typescript
 * const branch = new NeonBranch("production", {
 *   name: "production",
 * }, { provider, project });
 * ```
 */
export class NeonBranch extends pulumi.ComponentResource {
	/** Neon branch ID. */
	public readonly branchId: pulumi.Output<string>;

	constructor(
		name: string,
		args: NeonBranchArgs,
		opts: NeonBranchOptions,
	) {
		const { provider, project, ...pulumiOpts } = opts;

		super("infracraft:neon:Branch", name, {}, pulumiOpts);

		const resource = new NeonBranchResource(
			`${name}-resource`,
			{
				apiKey: provider.apiKey,
				projectId: project.projectId,
				name: args.name,
			},
			{ parent: this },
		);

		this.branchId = resource.id;

		this.registerOutputs({ branchId: this.branchId });
	}
}
