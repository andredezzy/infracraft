import path from "node:path";

import {
	buildSandboxScript,
	prepareSandboxWorkspace,
	SandboxMode,
} from "@infracraft/sandbox";

import type { GateProvider, NativeCliCommand } from "../providers/provider";

export interface DeployRunOptions {
	provider: GateProvider;
	token: string;
	passthroughArgs: string[];
	mode: SandboxMode;
	cwd?: string;
	spawner?: DeploySpawner;
}

export interface DeployRunResult {
	exitCode: number;
	url?: string;
	durationMs: number;
}

export interface SpawnedDeploy {
	stdout: ReadableStream<Uint8Array>;
	exited: Promise<number>;
}

export type DeploySpawner = (
	argv: string[],
	env: Record<string, string | undefined>,
	cwd: string,
) => SpawnedDeploy;

const defaultSpawner: DeploySpawner = (argv, env, cwd) => {
	const child = Bun.spawn(argv, {
		cwd,
		env: env as Record<string, string>,
		stdin: "inherit",
		stdout: "pipe",
		stderr: "inherit",
	});

	return { stdout: child.stdout, exited: child.exited };
};

/** POSIX single-quote escaping: ' → '\'' */
export function shellEscape(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Builds the sandboxed shell for a deploy, or null for `SandboxMode.NONE`
 * (a direct spawn is more faithful than a `sh -c` wrapper when there is no
 * sandbox to set up — and it works outside git repos).
 */
export function buildDeployScript(
	command: NativeCliCommand,
	mode: SandboxMode,
	appName: string,
): string | null {
	if (mode === SandboxMode.NONE) {
		return null;
	}

	const envPrefix = Object.entries(command.env)
		.map(([key, value]) => `${key}=${shellEscape(value)}`)
		.join(" ");

	const argvString = command.argv.map(shellEscape).join(" ");
	const cli = envPrefix ? `${envPrefix} ${argvString}` : argvString;

	return buildSandboxScript({ mode, appName, cli });
}

/**
 * Runs the native deploy, streaming stdout untouched while watching for the
 * provider's deploy URL. Resolves with the native exit code — never throws on
 * a failed deploy (the caller decides how to exit).
 */
export async function runDeploy(
	options: DeployRunOptions,
): Promise<DeployRunResult> {
	const { provider, token, passthroughArgs, mode } = options;
	const cwd = options.cwd ?? process.cwd();
	const spawner = options.spawner ?? defaultSpawner;
	const startedAt = Date.now();

	const command = provider.deployCli({ token, passthroughArgs });
	const script = buildDeployScript(command, mode, path.basename(cwd));

	if (script !== null) {
		prepareSandboxWorkspace();
	}

	let spawned: SpawnedDeploy;

	try {
		spawned =
			script === null
				? spawner(command.argv, { ...process.env, ...command.env }, cwd)
				: spawner(["/bin/sh", "-c", script], { ...process.env }, cwd);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(
				`${command.argv[0]} CLI not found — install it first (e.g. \`bun add -g ${command.argv[0]}\`).`,
			);
		}

		throw error;
	}

	let url: string | undefined;

	const reader = spawned.stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const scan = (line: string): void => {
		process.stdout.write(`${line}\n`);

		const match = line.match(provider.deployUrlPattern);

		if (match) {
			url = match[0];
		}
	};

	while (true) {
		const { done, value } = await reader.read();

		if (done) {
			break;
		}

		buffer += decoder.decode(value, { stream: true });

		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";

		for (const line of lines) {
			scan(line);
		}
	}

	if (buffer.trim()) {
		scan(buffer.trimEnd());
	}

	const exitCode = await spawned.exited;

	return { exitCode, url, durationMs: Date.now() - startedAt };
}
