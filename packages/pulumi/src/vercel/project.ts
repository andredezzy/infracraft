import * as pulumi from "@pulumi/pulumi";
import type { VercelProvider } from "./provider";

const VERCEL_API_URL = "https://api.vercel.com";

/**
 * Authoritative list of Vercel framework preset slugs.
 * Consumers may use this array for validation or UI rendering.
 * Source of truth: @vercel/frameworks (run `bun run script` to regenerate).
 * When Vercel adds a new framework, update this array and release a new version.
 */
export const VERCEL_FRAMEWORKS = [
	// Full-stack & React
	"blitzjs",
	"nextjs",
	"gatsby",
	"remix",
	"react-router",
	"astro",
	"preact",
	"solidstart-1",
	"solidstart",
	"create-react-app",
	"ionic-react",
	"tanstack-start",
	"redwoodjs",
	"hydrogen",
	// Vue ecosystem
	"vue",
	"nuxtjs",
	"vitepress",
	"vuepress",
	"gridsome",
	"saber",
	// Svelte ecosystem
	"svelte",
	"sveltekit",
	"sveltekit-1",
	"sapper",
	// Angular ecosystem
	"angular",
	"ionic-angular",
	"scully",
	// Static site generators
	"hexo",
	"eleventy",
	"docusaurus-2",
	"docusaurus",
	"hugo",
	"jekyll",
	"brunch",
	"middleman",
	"zola",
	// UI / component tools
	"storybook",
	"stencil",
	"dojo",
	"ember",
	"polymer",
	// Build tools
	"vite",
	"parcel",
	// CMS
	"sanity-v3",
	"sanity",
	// Node.js back-ends
	"nitro",
	"hono",
	"express",
	"h3",
	"koa",
	"nestjs",
	"elysia",
	"fastify",
	// Python
	"fastapi",
	"flask",
	"fasthtml",
	"django",
	// Other languages
	"ash",
	"axum",
	"actix-web",
	"ruby",
	"rust",
	"go",
	"python",
	"node",
	// Misc
	"xmcp",
	"umijs",
	"mastra",
	"services",
] as const;

/**
 * Vercel framework preset slug. Derived from {@link VERCEL_FRAMEWORKS} — single source of truth.
 * When Vercel adds a new framework, update {@link VERCEL_FRAMEWORKS} and release a new version.
 */
export type VercelFramework = (typeof VERCEL_FRAMEWORKS)[number];

/** Resolved inputs for the Vercel project dynamic provider. */
export interface VercelProjectInputs {
	/** Vercel API bearer token. */
	token: string;

	/** Vercel team/org ID. */
	teamId: string;

	/** Project name. */
	name: string;

	/** Framework preset. */
	framework?: VercelFramework;

	/** Relative path to the project root within a monorepo (e.g. `"apps/nexus"`). */
	rootDirectory?: string;

	/** Custom build command. */
	buildCommand?: string;

	/** Custom install command. */
	installCommand?: string;

	/** Custom output directory. */
	outputDirectory?: string;
}

/** Persisted state for the Vercel project. */
interface VercelProjectOutputs extends VercelProjectInputs {
	/** Vercel-assigned project ID. */
	projectId: string;
}

/** Vercel API response shape for a project. */
interface VercelProjectResponse {
	id: string;
	name: string;
}

/**
 * Fetches a Vercel project by name or ID.
 * Returns `null` if the project is not found (404).
 */
async function fetchProject(
	token: string,
	teamId: string,
	idOrName: string,
): Promise<VercelProjectResponse | null> {
	const response = await fetch(
		`${VERCEL_API_URL}/v9/projects/${encodeURIComponent(idOrName)}?teamId=${teamId}`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);

	if (response.status === 404) {
		return null;
	}

	if (!response.ok) {
		throw new Error(
			`Vercel API error fetching project "${idOrName}" (${response.status}): ${await response.text()}`,
		);
	}

	return (await response.json()) as VercelProjectResponse;
}

/**
 * Builds the project body for create / update calls.
 * Only includes defined optional fields.
 */
function buildProjectBody(
	inputs: Omit<VercelProjectInputs, "token" | "teamId">,
): Record<string, string> {
	const body: Record<string, string> = { name: inputs.name };

	if (inputs.framework !== undefined) {
		body.framework = inputs.framework;
	}

	if (inputs.rootDirectory !== undefined) {
		body.rootDirectory = inputs.rootDirectory;
	}

	if (inputs.buildCommand !== undefined) {
		body.buildCommand = inputs.buildCommand;
	}

	if (inputs.installCommand !== undefined) {
		body.installCommand = inputs.installCommand;
	}

	if (inputs.outputDirectory !== undefined) {
		body.outputDirectory = inputs.outputDirectory;
	}

	return body;
}

/**
 * Dynamic provider implementing adopt-or-create for Vercel projects.
 *
 * On `create()`, calls `GET /v9/projects/{name}?teamId=…`. If found, adopts
 * the existing project. If 404, creates a new one via `POST /v9/projects`.
 * Deletion is a no-op to protect production projects.
 */
class VercelProjectResourceProvider implements pulumi.dynamic.ResourceProvider {
	async create(
		inputs: VercelProjectInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		const existing = await fetchProject(
			inputs.token,
			inputs.teamId,
			inputs.name,
		);

		let projectId: string;

		if (existing) {
			pulumi.log.info(
				`Adopting existing Vercel project "${inputs.name}" (${existing.id})`,
			);

			projectId = existing.id;
		} else {
			pulumi.log.info(
				`Vercel project "${inputs.name}" not found — creating...`,
			);

			const response = await fetch(
				`${VERCEL_API_URL}/v9/projects?teamId=${inputs.teamId}`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${inputs.token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(buildProjectBody(inputs)),
				},
			);

			if (!response.ok) {
				throw new Error(
					`Vercel API error creating project "${inputs.name}" (${response.status}): ${await response.text()}`,
				);
			}

			const created = (await response.json()) as VercelProjectResponse;

			projectId = created.id;
		}

		const outs: VercelProjectOutputs = { ...inputs, projectId };

		return { id: projectId, outs };
	}

	async read(
		id: string,
		props: VercelProjectOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const project = await fetchProject(props.token, props.teamId, id);

		if (!project) {
			throw new Error(`Vercel project "${id}" not found during refresh`);
		}

		return {
			id: project.id,
			props: { ...props, name: project.name, projectId: project.id },
		};
	}

	async update(
		id: string,
		_olds: VercelProjectOutputs,
		news: VercelProjectInputs,
	): Promise<pulumi.dynamic.UpdateResult> {
		const response = await fetch(
			`${VERCEL_API_URL}/v9/projects/${id}?teamId=${news.teamId}`,
			{
				method: "PATCH",
				headers: {
					Authorization: `Bearer ${news.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(buildProjectBody(news)),
			},
		);

		if (!response.ok) {
			throw new Error(
				`Vercel API error updating project "${id}" (${response.status}): ${await response.text()}`,
			);
		}

		return { outs: { ...news, projectId: id } };
	}

	async delete(): Promise<void> {
		pulumi.log.warn(
			"Vercel project deletion skipped — projects are not deleted by Pulumi",
		);
	}

	async diff(
		_id: string,
		olds: VercelProjectOutputs,
		news: VercelProjectInputs,
	): Promise<pulumi.dynamic.DiffResult> {
		const replaces: string[] = [];
		const changes: string[] = [];

		if (olds.teamId !== news.teamId) {
			replaces.push("teamId");
		}

		const updatableFields = [
			"name",
			"framework",
			"rootDirectory",
			"buildCommand",
			"installCommand",
			"outputDirectory",
		] as const;

		for (const field of updatableFields) {
			if (olds[field] !== news[field]) {
				changes.push(field);
			}
		}

		return {
			changes: replaces.length > 0 || changes.length > 0,
			replaces,
			deleteBeforeReplace: true,
		};
	}
}

/** Internal dynamic resource — not part of the public API. */
class VercelProjectResource extends pulumi.dynamic.Resource {
	public declare readonly projectId: pulumi.Output<string>;

	constructor(
		name: string,
		args: {
			token: pulumi.Input<string>;
			teamId: pulumi.Input<string>;
			name: pulumi.Input<string>;
			framework?: pulumi.Input<VercelFramework>;
			rootDirectory?: pulumi.Input<string>;
			buildCommand?: pulumi.Input<string>;
			installCommand?: pulumi.Input<string>;
			outputDirectory?: pulumi.Input<string>;
		},
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			new VercelProjectResourceProvider(),
			name,
			{ ...args, projectId: undefined },
			opts,
		);
	}
}

/** Options type for VercelProject — replaces Pulumi's native `provider` field. */
type VercelProjectOptions = Omit<
	pulumi.ComponentResourceOptions,
	"provider"
> & {
	/** Vercel authentication context. */
	provider: VercelProvider;
};

/** Args for VercelProject. */
export interface VercelProjectArgs {
	/** Project name. Used for both adoption lookup and display name. */
	name: pulumi.Input<string>;

	/** Framework preset. */
	framework?: pulumi.Input<VercelFramework>;

	/** Relative path to the project root within a monorepo (e.g. `"apps/nexus"`). */
	rootDirectory?: pulumi.Input<string>;

	/** Custom build command. */
	buildCommand?: pulumi.Input<string>;

	/** Custom install command. */
	installCommand?: pulumi.Input<string>;

	/** Custom output directory. */
	outputDirectory?: pulumi.Input<string>;
}

/**
 * Manages a Vercel project with adopt-or-create semantics.
 *
 * On first `pulumi up`, looks up the project by name. If it already exists,
 * the resource adopts it. If not, a new project is created. Deletion is a
 * no-op to protect production projects.
 *
 * @example
 * ```typescript
 * const project = new VercelProject("nexus", {
 *   name: "nexus",
 *   framework: "nextjs",
 *   rootDirectory: "apps/nexus",
 * }, { provider });
 *
 * new VercelVariable("nexus-vars", {
 *   projectId: project.id,
 *   variables: { NEXT_PUBLIC_API_URL: meshUrl },
 * }, { provider });
 * ```
 */
export class VercelProject extends pulumi.ComponentResource {
	/** Vercel-assigned project ID. */
	public readonly id: pulumi.Output<string>;

	constructor(
		name: string,
		args: VercelProjectArgs,
		opts: VercelProjectOptions,
	) {
		const { provider, ...pulumiOpts } = opts;

		super("infracraft:vercel:Project", name, {}, pulumiOpts);

		const resource = new VercelProjectResource(
			`${name}-resource`,
			{
				token: provider.token,
				teamId: provider.teamId,
				...args,
			},
			{ parent: this },
		);

		this.id = resource.projectId;

		this.registerOutputs({ id: this.id });
	}
}
