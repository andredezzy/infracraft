import * as pulumi from "@pulumi/pulumi";
import { isResolvedString } from "../dynamic/is-resolved-string";
import {
	resolveCredential,
	resolveCredentialOutput,
} from "../dynamic/resolve-credential";
import { ApiNotFoundError } from "../errors/api-not-found-error";
import { VercelClient } from "./client";
import type { VercelProvider } from "./provider";

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
	/** Vercel API bearer token. Absent when `tokenEnvVar` is used instead. */
	token?: string;

	/** Env var name resolved to the token when `token` is absent (see `VercelProviderArgs.tokenEnvVar`). */
	tokenEnvVar?: string;

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

/** A single entry from `GET /v9/projects/{id}/domains`. */
interface VercelDomainEntry {
	name: string;
	verified: boolean;
	redirect: string | null;
	gitBranch: string | null;
}

/**
 * Picks a project's production domain from its domain list, mirroring how Vercel
 * derives `VERCEL_PROJECT_PRODUCTION_URL`: a verified, non-redirect, non-branch
 * domain, preferring a custom domain over the `*.vercel.app` default. Returns a
 * full `https://` URL. Falls back to `<name>.vercel.app` when the list is empty
 * (e.g. a freshly created project whose domain has not yet propagated).
 *
 * @param domains Domain entries from `GET /v9/projects/{id}/domains`
 * @param name Project name, used for the `<name>.vercel.app` fallback
 * @returns The production URL, e.g. `https://app.example.com`
 * @example
 * ```typescript
 * pickProductionDomain(
 *   [{ name: "x.vercel.app", verified: true, redirect: null, gitBranch: null },
 *    { name: "app.example.com", verified: true, redirect: null, gitBranch: null }],
 *   "x",
 * ); // => "https://app.example.com"
 * ```
 */
export function pickProductionDomain(
	domains: VercelDomainEntry[],
	name: string,
): string {
	const production = domains.filter(
		(domain) =>
			domain.verified && domain.redirect === null && domain.gitBranch === null,
	);

	const custom = production.find(
		(domain) => !domain.name.endsWith(".vercel.app"),
	);

	const fallback = production.find((domain) =>
		domain.name.endsWith(".vercel.app"),
	);

	return `https://${custom?.name ?? fallback?.name ?? `${name}.vercel.app`}`;
}

/**
 * Fetches a project's production URL from the Vercel domains API.
 * Throws on API failure — a wrong URL would silently misconfigure the app.
 */
async function fetchProductionUrl(
	token: string,
	teamId: string,
	idOrName: string,
	name: string,
): Promise<string> {
	const client = new VercelClient(token, teamId);

	const { domains = [] } = await client.get<{ domains?: VercelDomainEntry[] }>(
		`/v9/projects/${encodeURIComponent(idOrName)}/domains`,
	);

	return pickProductionDomain(domains, name);
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
 * `delete()` removes the project; protect shared projects via the `protect` option.
 *
 * @internal Exported only for unit testing; not part of the public API surface.
 */
export class VercelProjectResourceProvider
	implements pulumi.dynamic.ResourceProvider
{
	/**
	 * Validates inputs at plan time against Vercel's published naming rule
	 * (docs → Project configuration → General settings): "Project names can be
	 * up to 100 characters long and must be lowercase. They can include
	 * letters, digits, and the following characters: `.`, `_`, `-`. However,
	 * they cannot contain the sequence `---`."
	 */
	async check(
		_olds: VercelProjectInputs,
		news: VercelProjectInputs,
	): Promise<pulumi.dynamic.CheckResult<VercelProjectInputs>> {
		const failures: pulumi.dynamic.CheckFailure[] = [];

		if (
			isResolvedString(news.name) &&
			(!/^[a-z0-9._-]{1,100}$/.test(news.name) || news.name.includes("---"))
		) {
			failures.push({
				property: "name",
				reason: `name must be 1-100 lowercase characters (letters, digits, ".", "_", "-") without the sequence "---", got "${news.name}"`,
			});
		}

		return { inputs: news, failures };
	}

	async create(
		inputs: VercelProjectInputs,
	): Promise<pulumi.dynamic.CreateResult> {
		const client = new VercelClient(
			resolveCredential(inputs.token, inputs.tokenEnvVar),
			inputs.teamId,
		);

		const existing = await client.tryGet<VercelProjectResponse>(
			`/v9/projects/${encodeURIComponent(inputs.name)}`,
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

			const created = await client.post<VercelProjectResponse>(
				"/v9/projects",
				buildProjectBody(inputs),
			);

			projectId = created.id;
		}

		const outs: VercelProjectOutputs = { ...inputs, projectId };

		return { id: projectId, outs };
	}

	async read(
		id: string,
		props: VercelProjectOutputs,
	): Promise<pulumi.dynamic.ReadResult> {
		const client = new VercelClient(
			resolveCredential(props.token, props.tokenEnvVar),
			props.teamId,
		);

		const project = await client.tryGet<VercelProjectResponse>(
			`/v9/projects/${encodeURIComponent(id)}`,
		);

		if (!project) {
			// Resource gone → blank id lets refresh reconcile the deletion.
			return {};
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
		const client = new VercelClient(
			resolveCredential(news.token, news.tokenEnvVar),
			news.teamId,
		);

		await client.patch(`/v9/projects/${id}`, buildProjectBody(news));

		return { outs: { ...news, projectId: id } };
	}

	/**
	 * Deletes the project. Protection of shared/production projects is the consumer's
	 * responsibility via the `protect` resource option, not provider logic.
	 */
	async delete(id: string, props: VercelProjectOutputs): Promise<void> {
		const client = new VercelClient(
			resolveCredential(props.token, props.tokenEnvVar),
			props.teamId,
		);

		try {
			await client.delete(`/v9/projects/${encodeURIComponent(id)}`);
		} catch (error) {
			// Already gone — deletion is idempotent.
			if (!(error instanceof ApiNotFoundError)) {
				throw error;
			}
		}

		pulumi.log.info(`Deleted Vercel project "${props.name}" (${id})`);
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
			// projectId survives every in-place update (only teamId replaces), so
			// dependents (variables, domains, connections) keep a known projectId
			// during preview.
			stables: replaces.length === 0 ? ["projectId"] : [],
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
			token?: pulumi.Input<string>;
			tokenEnvVar?: pulumi.Input<string>;
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
			// The API token flows into dynamic-provider state with the outputs — mark it secret there.
			{ ...opts, additionalSecretOutputs: ["token"] },
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
 * the resource adopts it. If not, a new project is created. Deletion REALLY
 * deletes the Vercel project — set `protect: true` on precious ones.
 *
 * @example
 * ```typescript
 * const project = new VercelProject("nexus", {
 *   name: "nexus",
 *   framework: "nextjs",
 *   rootDirectory: "apps/nexus",
 * }, { provider });
 *
 * new VercelDeploy("nexus-deploy", {
 *   projectId: project.id,
 *   // The app's own URL comes from the project, not from config or a derived name.
 *   variables: { NEXTAUTH_URL: project.url },
 *   triggers: [sourceHash],
 * }, { provider });
 * ```
 */
export class VercelProject extends pulumi.ComponentResource {
	/** Vercel-assigned project ID. */
	public readonly id: pulumi.Output<string>;

	/**
	 * The project's production URL (with `https://`), e.g. `https://app.example.com`.
	 * Resolves to the custom production domain when one is attached, otherwise the
	 * `<name>.vercel.app` default — the source of truth for the app's own URL.
	 */
	public readonly url: pulumi.Output<string>;

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
				tokenEnvVar: provider.tokenEnvVar,
				teamId: provider.teamId,
				...args,
			},
			{ parent: this },
		);

		this.id = resource.projectId;

		// The production URL is fetched fresh from Vercel on every run (not persisted as
		// dynamic-resource state), so it is always current and resolves correctly on any
		// `up` without recreating the project. `unsecret` because a public domain is not
		// sensitive (only the token used to fetch it is) — keeping it out of the secret
		// serialization that feeds downstream Variable resources.
		this.url = pulumi.unsecret(
			pulumi
				.all([
					this.id,
					resolveCredentialOutput(provider.token, provider.tokenEnvVar),
					provider.teamId,
					pulumi.output(args.name),
				])
				.apply(([id, token, teamId, projectName]) =>
					fetchProductionUrl(token, teamId, id, projectName),
				),
		);

		this.registerOutputs({ id: this.id, url: this.url });
	}
}
