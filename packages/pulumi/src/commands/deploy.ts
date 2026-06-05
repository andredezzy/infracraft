// src/commands/deploy.ts
import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";

import { isGitGuard } from "../git-guard";
import { buildSandboxScript, isDeploySandbox } from "../sandbox";

export interface CreateDeployCommandArgs {
	/** Resource name; the child command is `<name>` and the sandbox dir uses it. */
	name: string;
	/** Fully-formed platform deploy command (may be an Output, e.g. Railway). */
	cli: pulumi.Input<string>;
	/** Redeploy triggers (source/env hashes). */
	triggers: pulumi.Input<pulumi.Input<string>[]>;
	/** Upload-scoping excludes (applied only in stub mode). */
	excludePaths?: string[];
	/** Shell run in the working dir before `cli` (e.g. write railpack.json). */
	setup?: string;
	/** Env passed to the command (secrets that survive preview; not the inlined ones). */
	environment?: Record<string, pulumi.Input<string>>;
}

export interface CreateDeployCommandResult {
	command: command.local.Command;
	/** The deploy CLI's final stdout line (the production URL for Vercel/Fly). */
	deploymentUrl: pulumi.Output<string>;
}

/** Reads a `dependsOn` opt into a flat array of resource instances. */
function dependsOnList(opts: pulumi.ComponentResourceOptions): unknown[] {
	const dep = opts.dependsOn;

	if (Array.isArray(dep)) {
		return dep;
	}

	return dep ? [dep] : [];
}

/**
 * Builds a sandboxed deploy command. Inspects `opts.dependsOn` by brand:
 * a DeploySandbox → isolate; a GitGuard → stub `.git`; GitGuard alone → throw.
 * The platform deploy resources call ONLY this; they never touch the sandbox.
 */
export function createDeployCommand(
	args: CreateDeployCommandArgs,
	opts: pulumi.ComponentResourceOptions,
): CreateDeployCommandResult {
	const deps = dependsOnList(opts);
	const sandbox = deps.some(isDeploySandbox);
	const gitGuard = deps.some(isGitGuard);

	if (gitGuard && !sandbox) {
		throw new Error(
			`[infracraft] ${args.name}: GitGuard has no effect without a DeploySandbox in dependsOn`,
		);
	}

	const env = pulumi.getStack();

	const create = pulumi.output(args.cli).apply((cli) =>
		buildSandboxScript({
			sandbox,
			gitGuard,
			appName: args.name,
			env,
			excludePaths: args.excludePaths,
			setup: args.setup,
			cli,
		}),
	);

	const cmd = new command.local.Command(
		args.name,
		{ create, triggers: args.triggers, environment: args.environment },
		opts,
	);

	const deploymentUrl = cmd.stdout.apply(
		(out) => out.trim().split("\n").pop() ?? "",
	);

	return { command: cmd, deploymentUrl };
}
