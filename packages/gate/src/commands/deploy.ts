import * as p from "@clack/prompts";
import { SandboxMode } from "@infracraft/sandbox";
import { defineCommand } from "citty";
import pc from "picocolors";

import { detectActiveAccount, ensureValidSession } from "../accounts/session";
import type { AccountStore } from "../accounts/store";
import { runDeploy } from "../deploy/runner";
import type { GateProvider } from "../providers/provider";
import { resolveAccount } from "./resolve-account";

export interface SplitDeployArgs {
	accountLabel: string | undefined;
	mode: SandboxMode;
	passthroughArgs: string[];
}

/** gate owns --account/-a, --no-sandbox, --git-metadata; everything else is
 * forwarded verbatim to the native CLI. Raw-args parsing (not citty arg defs)
 * so unknown native flags never error. */
export function splitDeployArgs(rawArgs: string[]): SplitDeployArgs {
	let accountLabel: string | undefined;
	let mode = SandboxMode.STUB;
	const passthroughArgs: string[] = [];

	for (let index = 0; index < rawArgs.length; index += 1) {
		const arg = rawArgs[index] as string;

		if (arg === "--account" || arg === "-a") {
			accountLabel = rawArgs[index + 1];
			index += 1;
		} else if (arg === "--no-sandbox") {
			mode = SandboxMode.NONE;
		} else if (arg === "--git-metadata") {
			mode = SandboxMode.ORIGINAL;
		} else {
			passthroughArgs.push(arg);
		}
	}

	return { accountLabel, mode, passthroughArgs };
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
				"Not a git repository — skipping the sandbox, deploying natively.",
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
			await runDeployCommand(provider, store, rawArgs as string[]);
		},
	});
}
