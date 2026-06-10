import * as p from "@clack/prompts";
import { SandboxMode } from "@infracraft/sandbox";
import { defineCommand } from "citty";
import pc from "picocolors";

import { detectActiveAccount, ensureValidSession } from "../accounts/session";
import type { AccountStore } from "../accounts/store";
import { runDeploy } from "../deploy/runner";
import type {
	DeployTargetCapability,
	GateProvider,
} from "../providers/provider";
import type { CommandContext, CommandSpec } from "../registry/command-spec";
import { InteractionMode } from "../registry/command-spec";
import { GateFlagRegion, splitGateFlags } from "../routing/split-gate-flags";
import { resolveAccount } from "./resolve-account";
import { runAction } from "./run-action";

export interface SplitDeployArgs {
	accountLabel: string | undefined;
	mode: SandboxMode;
	createTarget: boolean;
	passthroughArgs: string[];
	malformed: string | undefined;
}

/** gate owns --account/-a (via splitGateFlags; reserved shorthands stay
 * native), --no-sandbox, --git-metadata, --create-project; everything else is
 * forwarded verbatim to the native CLI. Nothing after `--` is interpreted. */
export function splitDeployArgs(
	provider: GateProvider,
	rawArgs: string[],
): SplitDeployArgs {
	let mode = SandboxMode.STUB;
	let createTarget = false;
	const remainder: string[] = [];
	let parsing = true;

	for (const arg of rawArgs) {
		if (!parsing) {
			remainder.push(arg);

			continue;
		}

		if (arg === "--") {
			parsing = false;
			remainder.push(arg);
		} else if (arg === "--no-sandbox") {
			mode = SandboxMode.NONE;
		} else if (arg === "--git-metadata") {
			mode = SandboxMode.ORIGINAL;
		} else if (arg === "--create-project") {
			createTarget = true;
		} else {
			remainder.push(arg);
		}
	}

	const split = splitGateFlags(
		provider,
		remainder,
		GateFlagRegion.NATIVE_REGION_ONLY,
	);

	return {
		accountLabel: split.accountLabel,
		mode,
		createTarget,
		passthroughArgs: split.nativeArgs,
		malformed: split.malformed,
	};
}

export enum DeployTargetPreflightOutcome {
	READY = "READY",
	ABORTED = "ABORTED",
}

export interface DeployTargetPreflightContext {
	deployTarget: DeployTargetCapability | undefined;
	token: string;
	/** Account identity, shown as the scope in messages. */
	identity: string;
	passthroughArgs: string[];
	/** --create-project: create a missing target without prompting. */
	createTarget: boolean;
	/** INTERACTIVE sessions may prompt; NON_INTERACTIVE runs fail fast. */
	interaction: InteractionMode;
}

/** Checks the explicit deploy target exists before spawning the native CLI,
 * offering to create it when missing. Verification failures degrade to a
 * warning + proceed — only a confirmed miss gates the deploy. */
export async function ensureDeployTarget(
	context: DeployTargetPreflightContext,
): Promise<DeployTargetPreflightOutcome> {
	const { deployTarget } = context;

	if (!deployTarget) {
		return DeployTargetPreflightOutcome.READY;
	}

	const name = deployTarget.resolveName(context.passthroughArgs);

	if (!name) {
		return DeployTargetPreflightOutcome.READY;
	}

	let exists: boolean;

	try {
		exists = await deployTarget.exists(context.token, name);
	} catch (error) {
		p.log.warn(
			`Could not verify ${deployTarget.noun} "${name}" exists (${(error as Error).message}). Continuing with deploy.`,
		);

		return DeployTargetPreflightOutcome.READY;
	}

	if (exists) {
		return DeployTargetPreflightOutcome.READY;
	}

	const noun = deployTarget.noun;

	const missing = `${noun.charAt(0).toUpperCase()}${noun.slice(1)} "${name}" was not found in scope ${context.identity}.`;

	if (!context.createTarget) {
		if (context.interaction === InteractionMode.NON_INTERACTIVE) {
			p.log.error(
				`${missing} Pass --create-project to create it, or create it first in the dashboard.`,
			);

			process.exitCode = 1;

			return DeployTargetPreflightOutcome.ABORTED;
		}

		const shouldCreate = await p.confirm({ message: `${missing} Create it?` });

		if (p.isCancel(shouldCreate)) {
			p.cancel("Cancelled.");
			process.exit(0);
		}

		if (!shouldCreate) {
			p.cancel("Cancelled.");

			return DeployTargetPreflightOutcome.ABORTED;
		}
	}

	await deployTarget.create(context.token, name);

	p.log.success(`Created ${deployTarget.noun} "${name}"`);

	return DeployTargetPreflightOutcome.READY;
}

/** Sandbox modes copy `git ls-files`; without a repo there is nothing to copy
 * — and no git metadata to guard. */
function isInsideGitRepo(): boolean {
	const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
		stdout: "ignore",
		stderr: "ignore",
	});

	return result.exitCode === 0;
}

export async function runDeployCommand(
	context: CommandContext,
	rawArgs: string[],
): Promise<void> {
	const { provider, store, interaction } = context;
	const split = splitDeployArgs(provider, rawArgs);
	const { accountLabel, createTarget, passthroughArgs } = split;
	let mode = split.mode;

	if (split.malformed) {
		throw new Error(split.malformed);
	}

	if (mode !== SandboxMode.NONE && !isInsideGitRepo()) {
		p.log.info(
			pc.gray(
				"Not a git repository. Skipping the sandbox and deploying natively.",
			),
		);

		mode = SandboxMode.NONE;
	}

	const account = accountLabel
		? await resolveAccount(provider, store, accountLabel, { interaction })
		: (detectActiveAccount(provider, store) ??
			(await resolveAccount(provider, store, undefined, { interaction })));

	const valid = await ensureValidSession(provider, store, account, {
		interaction,
	});

	p.log.success(
		`Account: ${pc.bold(valid.label)} ${pc.gray(`(${valid.identity})`)}`,
	);

	const outcome = await ensureDeployTarget({
		deployTarget: provider.deployTarget,
		token: valid.session.token,
		identity: valid.identity,
		passthroughArgs,
		createTarget,
		interaction,
	});

	if (outcome === DeployTargetPreflightOutcome.ABORTED) {
		return;
	}

	if (mode === SandboxMode.STUB) {
		p.log.info(pc.gray("Sandboxed deploy: isolated copy, stub .git"));
	} else if (mode === SandboxMode.ORIGINAL) {
		p.log.info(pc.gray("Sandboxed deploy: isolated copy, real .git"));
	} else {
		p.log.warn("Sandbox disabled: deploying from the live working tree");
	}

	const command = provider.nativeCli({
		token: valid.session.token,
		args: [
			provider.deployVerb,
			...provider.deployDefaultFlags,
			...passthroughArgs,
		],
	});

	const result = await runDeploy({
		command,
		urlPattern: provider.deployUrlPattern,
		mode,
	});

	if (result.url) {
		p.log.success(`Deployed: ${pc.cyan(result.url)}`);
	}

	if (result.exitCode !== 0) {
		p.log.error(
			`${provider.binary} ${provider.deployVerb} failed (exit code ${result.exitCode})`,
		);

		process.exitCode = result.exitCode;

		return;
	}

	p.outro(`Done in ${(result.durationMs / 1000).toFixed(1)}s`);
}

export const deployCommandSpec: CommandSpec = {
	description: "Sandboxed native deploy with account selection",
	usage: "[gate flags] [native args...]",
	async run(context, args) {
		p.intro(`gate ${context.provider.binary} ${context.provider.deployVerb}`);

		await runAction(() => runDeployCommand(context, args));
	},
};

export function makeDeployCommand(provider: GateProvider, store: AccountStore) {
	return defineCommand({
		meta: {
			name: provider.deployVerb,
			description: `Sandboxed \`${provider.binary} ${provider.deployVerb}\` with account selection`,
		},
		async run({ rawArgs }) {
			p.intro(`gate ${provider.binary} ${provider.deployVerb}`);

			const interaction =
				process.stdout.isTTY === true
					? InteractionMode.INTERACTIVE
					: InteractionMode.NON_INTERACTIVE;

			await runAction(() =>
				runDeployCommand({ provider, store, interaction }, rawArgs as string[]),
			);
		},
	});
}
