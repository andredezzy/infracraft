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
	/** The last http(s) URL the deploy CLI printed to stdout (its production URL). */
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

	// The deploy CLI prints its URL somewhere in stdout, but not always as the
	// final line — Vercel, for one, follows it with pretty-printed JSON whose
	// closing brace would win a naive last-line grab. Take the last whitespace-
	// delimited token that is an http(s) URL instead; "" when there is none (the
	// command never ran, errored early, or emitted no URL).
	const deploymentUrl = cmd.stdout.apply((out) => {
		const urls = (out ?? "")
			.split(/\s+/)
			.filter((token) => /^https?:\/\//.test(token));

		return urls.at(-1) ?? "";
	});

	return { command: cmd, deploymentUrl };
}
