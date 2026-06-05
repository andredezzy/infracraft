// src/railway/deploy.ts  (replace entire file)
import * as pulumi from "@pulumi/pulumi";

import { createDeployCommand } from "../commands/deploy";
import type { RailwayEnvironment } from "./environment";
import type { RailwayProject } from "./project";
import type { RailwayProvider } from "./provider";
import { RailwayBuilder, type RailwayService } from "./service";

export interface RailwayDeployConfig {
	builder?: RailwayBuilder;
	startCommand?: string;
	preDeployCommand?: string;
}

export interface RailwayDeployArgs {
	/** Redeploy triggers (e.g. source hashes, env hashes). */
	triggers: pulumi.Input<pulumi.Input<string>[]>;
	/** Paths excluded from the upload when running with `DeploySandbox` + `GitGuard`. */
	excludePaths?: string[];
	/** Railpack configuration written to `railpack.json` before deploy. */
	railpackConfig?: Record<string, unknown>;
}

type RailwayDeployOptions = Omit<
	pulumi.ComponentResourceOptions,
	"provider"
> & {
	provider: RailwayProvider;
	project: RailwayProject;
	environment: RailwayEnvironment;
	service: RailwayService;
	/** Environment-scoped Railway deploy token (provision via RailwayProjectToken). */
	projectToken: pulumi.Input<string>;
};

/**
 * The deploy-wait poller. `railway up --ci` only blocks until upload; this polls
 * the Railway GraphQL API to a terminal status and fails the resource on
 * FAILED/CRASHED/REMOVED. Runs under `node -e`, single-quoted in the shell, so it
 * uses ONLY double quotes and reads inputs from IC_* env vars.
 */
const DEPLOY_WAIT_SCRIPT = `const t=process.env.IC_TOK,p=process.env.IC_PROJ,e=process.env.IC_ENV,s=process.env.IC_SVC;const u="https://backboard.railway.app/graphql/v2";const q=(query,variables)=>fetch(u,{method:"POST",headers:{"Project-Access-Token":t,"Content-Type":"application/json"},body:JSON.stringify({query,variables})}).then(r=>r.json()).catch(()=>({}));const sl=ms=>new Promise(r=>setTimeout(r,ms));(async()=>{let id;for(let i=0;i<6&&!id;i++){const d=await q("query($p:String!,$e:String!,$s:String!){deployments(first:1,input:{projectId:$p,environmentId:$e,serviceId:$s}){edges{node{id status}}}}",{p,e,s});const g=d&&d.data&&d.data.deployments&&d.data.deployments.edges;if(g&&g[0])id=g[0].node.id;if(!id)await sl(5000);}if(!id){console.error("[infracraft] could not resolve Railway deployment id; build succeeded, not blocking");process.exit(0);}for(let i=0;i<120;i++){const r=await q("query($d:String!){deployment(id:$d){status}}",{d:id});const st=r&&r.data&&r.data.deployment&&r.data.deployment.status;if(st)console.error("[infracraft] railway deployment "+id+" status="+st);if(st==="SUCCESS")process.exit(0);if(st==="FAILED"||st==="CRASHED"||st==="REMOVED"){const l=await q("query($d:String!){deploymentLogs(deploymentId:$d,limit:60){message}}",{d:id});const lg=(l&&l.data&&l.data.deploymentLogs)||[];for(const x of lg)console.error("    "+(x.message||""));console.error("[infracraft] railway deployment "+id+" "+st+" — failing the Pulumi resource");process.exit(1);}await sl(10000);}console.error("[infracraft] timed out waiting for Railway deployment "+id);process.exit(1);})();`;

/**
 * Deploys a Railway service and waits for a terminal status. Isolation/git are the
 * seam's job (list a `DeploySandbox` and optionally a `GitGuard` in `dependsOn`).
 *
 * @example
 * ```typescript
 * new RailwayDeploy("mesh", { triggers: [sourceHash], railpackConfig: { apt: ["libatomic1"] } },
 *   { provider, project, environment, service, projectToken: token.token, dependsOn: [sandbox, gitGuard] });
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

		// Token is inlined (not via the env map): it is an unknown secret at preview,
		// and an unknown secret in `environment` makes `pulumi preview` fail.
		const cli = pulumi.interpolate`RAILWAY_TOKEN=${projectToken} railway up --ci --project ${project.id} --service ${service.id} --environment ${environment.id}; EXIT=$?; if [ "$EXIT" -ne 0 ]; then exit "$EXIT"; fi; if [ -n "$INFRACRAFT_SKIP_DEPLOY_WAIT" ]; then exit 0; fi; IC_TOK=${projectToken} IC_PROJ=${project.id} IC_ENV=${environment.id} IC_SVC=${service.id} node -e '${DEPLOY_WAIT_SCRIPT}'`;

		const setup = args.railpackConfig
			? `printf '${JSON.stringify(args.railpackConfig).replace(/'/g, "\\'")}' > railpack.json`
			: undefined;

		createDeployCommand(
			{
				name,
				cli,
				triggers: args.triggers,
				excludePaths: args.excludePaths,
				setup,
			},
			{ parent: this, ...pulumiOpts },
		);

		this.registerOutputs({});
	}
}
