import * as pulumi from "@pulumi/pulumi";
import { isResolvedString } from "../dynamic/is-resolved-string";
import { resolveCredential } from "../dynamic/resolve-credential";
import { ApiNotFoundError } from "../errors/api-not-found-error";
import { NeonClient } from "./client";
import type { NeonProject } from "./project";
import type { NeonProvider } from "./provider";

/** Resolved inputs for the Neon branch dynamic provider. */
export interface NeonBranchInputs {
	/** Neon API key. Absent when `apiKeyEnvVar` is used instead. */
	apiKey?: string;

	/** Env var name resolved to the API key when `apiKey` is absent (see `NeonProviderArgs.apiKeyEnvVar`). */
	apiKeyEnvVar?: string;

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
		/** Whether this is the project's default branch (Neon refuses to delete it). */
		default: boolean;
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
 *
 * @internal Exported only for unit testing; not part of the public API surface.
 */
export class NeonBranchResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
	/**
	 * Validates inputs at plan time. An empty branch name would otherwise fail
	 * deep inside the Neon API call — and never match on the adopt lookup.
	 */
	async check(
		_olds: NeonBranchInputs,
		news: NeonBranchInputs,
	): Promise<pulumi.dynamic.CheckResult<NeonBranchInputs>> {
		const failures: pulumi.dynamic.CheckFailure[] = [];

		if (isResolvedString(news.name) && news.name.trim().length === 0) {
			failures.push({
				property: "name",
				reason: 'name must be a non-empty branch name (e.g. "production")',
			});
		}

		return { inputs: news, failures };
	}

	async create(inputs: NeonBranchInputs): Promise<pulumi.dynamic.CreateResult> {
		const client = new NeonClient(
			resolveCredential(inputs.apiKey, inputs.apiKeyEnvVar),
		);

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
		const client = new NeonClient(
			resolveCredential(props.apiKey, props.apiKeyEnvVar),
		);

		try {
			const result = await client.get<BranchResponse>(
				`/projects/${props.projectId}/branches/${id}`,
			);

			// parentName is preserved from prior state (props): the Neon API does not expose
			// a branch's parent on GET /branches/:id, so it cannot be re-derived here.
			return {
				id: result.branch.id,
				props: { ...props, name: result.branch.name },
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
		_olds: NeonBranchOutputs,
		news: NeonBranchInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		const client = new NeonClient(
			resolveCredential(news.apiKey, news.apiKeyEnvVar),
		);

		await client.patch(`/projects/${news.projectId}/branches/${id}`, {
			branch: { name: news.name },
		});

		return { outs: { ...news } };
	}

	/**
	 * Deletes the branch. Protection of shared/production branches is the consumer's
	 * responsibility via the `protect` resource option, not provider logic.
	 */
	async delete(id: string, props: NeonBranchOutputs): Promise<void> {
		const client = new NeonClient(
			resolveCredential(props.apiKey, props.apiKeyEnvVar),
		);

		// Neon refuses to delete a project's default branch (live-proven API
		// truth). Checked via a GET rather than matching the refusal's error
		// message (brittle) — the default branch's lifecycle belongs to the
		// project, not this resource, so skipping it here is deliberate.
		try {
			const current = await client.get<BranchResponse>(
				`/projects/${props.projectId}/branches/${id}`,
			);

			if (current.branch.default) {
				pulumi.log.warn(
					`Neon branch "${id}" is the project's default branch — Neon refuses to delete it; skipping (its lifecycle belongs to the project, not this resource)`,
				);

				return;
			}
		} catch (error) {
			if (error instanceof ApiNotFoundError) {
				pulumi.log.warn(`Neon branch "${id}" already deleted`);

				return;
			}

			throw error;
		}

		try {
			await client.delete(`/projects/${props.projectId}/branches/${id}`);
		} catch (error) {
			// Already gone — deletion is idempotent.
			if (error instanceof ApiNotFoundError) {
				pulumi.log.warn(`Neon branch "${id}" already deleted`);

				return;
			}

			throw error;
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
	constructor(
		name: string,
		args: {
			apiKey?: pulumi.Input<string>;
			apiKeyEnvVar?: pulumi.Input<string>;
			projectId: pulumi.Input<string>;
			name: pulumi.Input<string>;
			/** Name of the parent branch; omit for project-root branches. */
			parentName?: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new NeonBranchResourceProvider(),
			name,
			{ ...args },
			// The API key flows into dynamic-provider state with the outputs — mark it secret there.
			{ ...opts, additionalSecretOutputs: ["apiKey"] },
		);
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
	 * Maps to the Neon API field `branch.parent_id` after name → ID resolution.
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
				apiKeyEnvVar: provider.apiKeyEnvVar,
				projectId: project.id,
				name: args.name,
				parentName: args.parent,
			},
			// Forward the consumer's resource options (e.g. `retainOnDelete`) to the
			// underlying resource — Pulumi auto-inherits provider/protect from the
			// parent component, but not everything else.
			pulumi.mergeOptions(pulumiOpts, { parent: this }),
		);

		this.id = resource.id;

		this.registerOutputs({ id: this.id });
	}
}
