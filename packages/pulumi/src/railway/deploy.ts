import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";
import { stableDir } from "../stable-dir";
import type { RailwayEnvironment } from "./environment";
import type { RailwayProject } from "./project";
import type { RailwayProvider } from "./provider";
import { RailwayBuilder, type RailwayService } from "./service";

/** Build and deploy configuration for a Railway service. */
export interface RailwayDeployConfig {
	/** Build system to use when building the service. */
	builder?: RailwayBuilder;

	/** Shell command executed to start the service at runtime. */
	startCommand?: string;

	/** Shell command executed before the main deploy (e.g. migrations). */
	preDeployCommand?: string;
}

/** Args for RailwayDeploy. */
export interface RailwayDeployArgs {
	/**
	 * Absolute path to the monorepo root (working directory for `railway up`).
	 * Stored relative to the Pulumi program directory so the command stays stable
	 * across machines and CI (see {@link stableDir}).
	 */
	directory: string;

	/** Values that trigger a redeploy when changed (e.g. source hashes, env hashes). */
	triggers: pulumi.Input<pulumi.Input<string>[]>;

	/** Directories to exclude via `.railwayignore`. */
	excludePaths?: string[];

	/** Railpack configuration written to `railpack.json` before deploy. */
	railpackConfig?: Record<string, unknown>;
}

/** Options type for RailwayDeploy — replaces Pulumi's native `provider` field. */
type RailwayDeployOptions = Omit<
	pulumi.ComponentResourceOptions,
	"provider"
> & {
	/** Railway authentication context. */
	provider: RailwayProvider;

	/** Railway project context. */
	project: RailwayProject;

	/** Railway environment context. */
	environment: RailwayEnvironment;

	/** Railway service context. */
	service: RailwayService;

	/** Environment-scoped Railway deploy token. Provision via {@link RailwayProjectToken}. */
	projectToken: pulumi.Input<string>;
};

const LOCK_DIR = "/tmp/.railway-upload-lock";

/**
 * Deploys a Railway service and waits for the deployment to reach a terminal status.
 *
 * `railway up --ci` only blocks until the build UPLOAD completes; Railway's image
 * finalization, the pre-deploy hook (e.g. migrations), the health check, and promotion
 * all run AFTER the CLI returns. So after `up` succeeds, this polls the Railway GraphQL API
 * for the deployment's status and **fails the resource (exit 1) on FAILED / CRASHED /
 * REMOVED** — without it, a deployment that fails post-build is reported as a successful
 * `pulumi up` and the previous version silently stays live. Set `INFRACRAFT_SKIP_DEPLOY_WAIT`
 * to bypass the wait. Status reads use the env-scoped project token via the
 * `Project-Access-Token` header (Railway rejects project tokens on `Authorization: Bearer`);
 * the poll runs under `node` (Pulumi's nodejs runtime) and uses `fetch` (Node 18+).
 *
 * Multiple deploys run in parallel — a mkdir lock serializes only the
 * brief upload phase (~5s) when `.railwayignore` must be consistent,
 * then releases so builds stream concurrently.
 *
 * @example
 * ```typescript
 * new RailwayDeploy("api-deploy", {
 *   directory: monorepoRoot,
 *   triggers: [sourceHash],
 * }, { provider, project, environment, service, projectToken: stagingToken.token });
 * ```
 */
export class RailwayDeploy extends pulumi.ComponentResource {
	constructor(
		name: string,
		args: RailwayDeployArgs,
		opts: RailwayDeployOptions,
	) {
		const {
			provider,
			project,
			environment,
			service,
			projectToken,
			...pulumiOpts
		} = opts;

		super("infracraft:railway:Deploy", name, {}, pulumiOpts);

		const ignorePatterns = (args.excludePaths ?? [])
			.map((dir) => {
				if (dir.startsWith("apps/")) {
					return `${dir}/**\\n!${dir}/package.json`;
				}

				return dir;
			})
			.join("\\n");

		const writeIgnore = ignorePatterns
			? `printf '${ignorePatterns}\\n' > .railwayignore`
			: "";

		const writeRailpack = args.railpackConfig
			? `printf '${JSON.stringify(args.railpackConfig).replace(/'/g, "\\'")}' > railpack.json`
			: "";

		const setupLines = [writeIgnore, writeRailpack].filter(Boolean).join("; ");

		// The deploy token is inlined into the create command (RAILWAY_TOKEN=… railway up) rather
		// than passed via command.local.Command's `environment` map. The token is auto-minted (a
		// RailwayProjectToken), so it is an UNKNOWN secret at preview time, and an unknown secret in
		// the `environment` map makes `pulumi preview` fail ("malformed RPC secret: missing value").
		// Inlining keeps the token secret in state while letting preview serialize cleanly.
		// Polls the Railway deployment to a terminal status after `railway up` returns. Runs via
		// `node -e` and is single-quoted in the shell, so the script uses ONLY double quotes — no
		// single quotes, no backticks, no `${…}` — and reads its inputs from IC_* env vars. The
		// `$p`/`$e`/`$s`/`$d` tokens are GraphQL variables (the shell single-quoting leaves them
		// literal). Exits 0 on SUCCESS (or if the deployment id can't be resolved — build already
		// succeeded), and exits 1 (failing the Pulumi resource) on FAILED/CRASHED/REMOVED or timeout.
		const deployWaitScript = `const t=process.env.IC_TOK,p=process.env.IC_PROJ,e=process.env.IC_ENV,s=process.env.IC_SVC;const u="https://backboard.railway.app/graphql/v2";const q=(query,variables)=>fetch(u,{method:"POST",headers:{"Project-Access-Token":t,"Content-Type":"application/json"},body:JSON.stringify({query,variables})}).then(r=>r.json()).catch(()=>({}));const sl=ms=>new Promise(r=>setTimeout(r,ms));(async()=>{let id;for(let i=0;i<6&&!id;i++){const d=await q("query($p:String!,$e:String!,$s:String!){deployments(first:1,input:{projectId:$p,environmentId:$e,serviceId:$s}){edges{node{id status}}}}",{p,e,s});const g=d&&d.data&&d.data.deployments&&d.data.deployments.edges;if(g&&g[0])id=g[0].node.id;if(!id)await sl(5000);}if(!id){console.error("[infracraft] could not resolve Railway deployment id; build succeeded, not blocking");process.exit(0);}for(let i=0;i<120;i++){const r=await q("query($d:String!){deployment(id:$d){status}}",{d:id});const st=r&&r.data&&r.data.deployment&&r.data.deployment.status;if(st)console.error("[infracraft] railway deployment "+id+" status="+st);if(st==="SUCCESS")process.exit(0);if(st==="FAILED"||st==="CRASHED"||st==="REMOVED"){const l=await q("query($d:String!){deploymentLogs(deploymentId:$d,limit:60){message}}",{d:id});const lg=(l&&l.data&&l.data.deploymentLogs)||[];for(const x of lg)console.error("    "+(x.message||""));console.error("[infracraft] railway deployment "+id+" "+st+" — failing the Pulumi resource");process.exit(1);}await sl(10000);}console.error("[infracraft] timed out waiting for Railway deployment "+id);process.exit(1);})();`;

		const deployCmd = pulumi.interpolate`while ! mkdir ${LOCK_DIR} 2>/dev/null; do sleep 1; done; ${setupLines}; { sleep 5; rm -f .railwayignore railpack.json; rmdir ${LOCK_DIR} 2>/dev/null; } & RAILWAY_TOKEN=${projectToken} railway up --ci --project ${project.id} --service ${service.id} --environment ${environment.id}; EXIT=$?; rm -f .railwayignore railpack.json; rmdir ${LOCK_DIR} 2>/dev/null; wait; if [ "$EXIT" -ne 0 ]; then exit "$EXIT"; fi; if [ -n "$INFRACRAFT_SKIP_DEPLOY_WAIT" ]; then exit 0; fi; IC_TOK=${projectToken} IC_PROJ=${project.id} IC_ENV=${environment.id} IC_SVC=${service.id} node -e '${deployWaitScript}'`;

		new command.local.Command(
			`${name}-deploy`,
			{
				create: deployCmd,
				triggers: args.triggers,
				dir: stableDir(args.directory),
			},
			{ parent: this },
		);

		this.registerOutputs({});
	}
}
