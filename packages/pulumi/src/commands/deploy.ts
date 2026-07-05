// src/commands/deploy.ts
import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";

import { isGitGuard } from "../git-guard";
import { buildSandboxScript, isDeploySandbox, SandboxMode } from "../sandbox";

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
	/**
	 * Piped to the command's standard input. The channel for secrets that are
	 * unknown at preview (resource-output tokens): the `environment` map fails
	 * preview on unknowns, and inlining into `cli` leaks the value in
	 * pulumi-command's failure error, which Pulumi does not scrub.
	 */
	stdin?: pulumi.Input<string>;
}

export interface CreateDeployCommandResult {
	command: command.local.Command;
	/** The deploy CLI's final stdout line (the production URL for Vercel/Fly). */
	deploymentUrl: pulumi.Output<string>;
}

/** Reads a `dependsOn` opt into a flat array of resource instances. */
export function dependsOnList(
	opts: pulumi.ComponentResourceOptions,
): unknown[] {
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

	let mode = SandboxMode.NONE;

	if (sandbox) {
		mode = gitGuard ? SandboxMode.STUB : SandboxMode.ORIGINAL;
	}

	const env = pulumi.getStack();

	const create = pulumi.output(args.cli).apply((cli) =>
		buildSandboxScript({
			mode,
			appName: args.name,
			env,
			excludePaths: args.excludePaths,
			setup: args.setup,
			cli,
		}),
	);

	const cmd = new command.local.Command(
		args.name,
		{
			create,
			triggers: args.triggers,
			environment: args.environment,
			stdin: args.stdin,
		},
		opts,
	);

	// stdout is undefined when the command never ran or errored before emitting
	// output — guard it so a real failure isn't masked by a TypeError on trim.
	const deploymentUrl = cmd.stdout.apply(
		(out) => (out ?? "").trim().split("\n").pop() ?? "",
	);

	return { command: cmd, deploymentUrl };
}
