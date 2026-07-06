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
	/**
	 * Explicit opt-in to deploy WITHOUT a `DeploySandbox` in `dependsOn`.
	 * Without this, an unsandboxed deploy throws instead of silently running
	 * against the live working tree (uncommitted changes included) — this is
	 * the guard that makes that regression class impossible. Defaults to `false`.
	 */
	allowUnsandboxed?: boolean;
}

export interface CreateDeployCommandResult {
	command: command.local.Command;
	/** The last http(s) URL the deploy CLI printed to stdout (its production URL). */
	deploymentUrl: pulumi.Output<string>;
}

/**
 * Reads a `dependsOn` opt into a flat array of resource instances.
 *
 * @throws {Error} When `dependsOn` is a wrapped `Output` (e.g. the result of
 *   `.apply()` or `pulumi.all()`) rather than a plain array or resource —
 *   `isDeploySandbox`/`isGitGuard` brand checks cannot see through an Output,
 *   so a sandbox hidden inside one would silently fail to be detected.
 */
export function dependsOnList(
	opts: pulumi.ComponentResourceOptions,
): unknown[] {
	const dep = opts.dependsOn;

	if (dep === undefined) {
		return [];
	}

	if (Array.isArray(dep)) {
		return dep;
	}

	if (pulumi.Output.isInstance(dep)) {
		throw new Error(
			"[infracraft] dependsOn was passed as a wrapped Output (e.g. from .apply() or pulumi.all()) — DeploySandbox/GitGuard brands cannot be detected inside one. Pass dependsOn as a plain array of resources instead.",
		);
	}

	return [dep];
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

	if (!sandbox && !args.allowUnsandboxed) {
		throw new Error(
			`[infracraft] ${args.name}: no DeploySandbox in dependsOn — this would deploy the LIVE working tree (uncommitted changes included) instead of a clean, git-tracked copy. Fix: add a DeploySandbox to this deploy's own dependsOn, or set allowUnsandboxed: true to opt in deliberately.`,
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

	// The deploy CLI prints its URL somewhere in stdout, but not always as a
	// clean bare token on the final line — Vercel, for one, can interleave
	// JSON-formatted build/event logs whose URL field arrives wrapped in
	// quotes/braces/commas (e.g. `"https://app.vercel.app"},`), which a naive
	// `^https?://` match on the raw token would miss entirely. Strip wrapping
	// quote/bracket/punctuation characters from each whitespace-delimited
	// token first, then take the last one that is an http(s) URL; "" when
	// there is none (the command never ran, errored early, or emitted no URL).
	const deploymentUrl = cmd.stdout.apply((out) => {
		const urls = (out ?? "")
			.split(/\s+/)
			.map((token) => token.replace(/^["'`([{]+|["'`)\]},;.]+$/g, ""))
			.filter((token) => /^https?:\/\//.test(token));

		return urls.at(-1) ?? "";
	});

	return { command: cmd, deploymentUrl };
}
