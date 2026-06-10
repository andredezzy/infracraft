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
import { resolveAccount } from "./resolve-account";
import { runAction } from "./run-action";

export interface SplitDeployArgs {
	accountLabel: string | undefined;
	mode: SandboxMode;
	createTarget: boolean;
	passthroughArgs: string[];
}

/** gate owns --account/-a, --no-sandbox, --git-metadata, --create-project;
 * everything else is forwarded verbatim to the native CLI. Raw-args parsing
 * (not citty arg defs) so unknown native flags never error. */
export function splitDeployArgs(rawArgs: string[]): SplitDeployArgs {
	let accountLabel: string | undefined;
	let mode = SandboxMode.STUB;
	let createTarget = false;
	const passthroughArgs: string[] = [];

	for (let index = 0; index < rawArgs.length; index += 1) {
		const arg = rawArgs[index] as string;

		if (arg.startsWith("--account=")) {
			accountLabel = arg.slice("--account=".length);

			continue;
		}

		if (arg === "--account" || arg === "-a") {
			accountLabel = rawArgs[index + 1];
			index += 1;
		} else if (arg === "--no-sandbox") {
			mode = SandboxMode.NONE;
		} else if (arg === "--git-metadata") {
			mode = SandboxMode.ORIGINAL;
		} else if (arg === "--create-project") {
			createTarget = true;
		} else {
			passthroughArgs.push(arg);
		}
	}

	return { accountLabel, mode, createTarget, passthroughArgs };
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
	/** TTY sessions may prompt; non-interactive runs fail fast. */
	interactive: boolean;
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
		if (!context.interactive) {
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

	p.log.success(`Created ${deployTarget.noun} ${name}`);

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

async function runDeployCommand(
	provider: GateProvider,
	store: AccountStore,
	rawArgs: string[],
): Promise<void> {
	const split = splitDeployArgs(rawArgs);
	const { accountLabel, passthroughArgs } = split;
	let mode = split.mode;

	if (mode !== SandboxMode.NONE && !isInsideGitRepo()) {
		p.log.info(
			pc.gray(
				"Not a git repository. Skipping the sandbox and deploying natively.",
			),
		);

		mode = SandboxMode.NONE;
	}

	const account = accountLabel
		? await resolveAccount(provider, store, accountLabel)
		: (detectActiveAccount(provider, store) ??
			(await resolveAccount(provider, store, undefined)));

	const valid = await ensureValidSession(provider, store, account);

	p.log.success(
		`Account: ${pc.bold(valid.label)} ${pc.gray(`(${valid.identity})`)}`,
	);

	if (mode === SandboxMode.STUB) {
		p.log.info(pc.gray("Sandboxed deploy: isolated copy, metadata-free .git"));
	} else if (mode === SandboxMode.ORIGINAL) {
		p.log.info(pc.gray("Sandboxed deploy: isolated copy, real .git"));
	} else {
		p.log.warn("Sandbox disabled: deploying from the live working tree");
	}

	const result = await runDeploy({
		provider,
		token: valid.session.token,
		passthroughArgs,
		mode,
	});

	if (result.url) {
		p.log.success(`Deployed: ${pc.cyan(result.url)}`);
	}

	if (result.exitCode !== 0) {
		p.log.error(
			`${provider.binary} ${provider.layout.deployVerb} failed (exit code ${result.exitCode})`,
		);

		process.exitCode = result.exitCode;

		return;
	}

	p.outro(`Done in ${(result.durationMs / 1000).toFixed(1)}s`);
}

export function makeDeployCommand(provider: GateProvider, store: AccountStore) {
	return defineCommand({
		meta: {
			name: provider.layout.deployVerb,
			description: `Sandboxed \`${provider.binary} ${provider.layout.deployVerb}\` with account selection`,
		},
		async run({ rawArgs }) {
			p.intro(`gate ${provider.binary} ${provider.layout.deployVerb}`);

			await runAction(() =>
				runDeployCommand(provider, store, rawArgs as string[]),
			);
		},
	});
}
