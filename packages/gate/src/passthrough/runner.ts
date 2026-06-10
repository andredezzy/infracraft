import type { GateProvider } from "../providers/provider";

export interface PassthroughRunOptions {
	provider: GateProvider;
	token: string;
	nativeArgs: string[];
	spawner?: PassthroughSpawner;
}

export interface PassthroughRunResult {
	exitCode: number;
}

export interface SpawnedPassthrough {
	exited: Promise<number>;
}

export type PassthroughSpawner = (
	argv: string[],
	env: Record<string, string | undefined>,
) => SpawnedPassthrough;

const defaultSpawner: PassthroughSpawner = (argv, env) => {
	const child = Bun.spawn(argv, {
		env: env as Record<string, string>,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});

	return { exited: child.exited };
};

/**
 * Runs an arbitrary native command with full TTY passthrough — no sandbox, no
 * URL scanning, no output processing. Resolves with the native exit code.
 */
export async function runPassthrough(
	options: PassthroughRunOptions,
): Promise<PassthroughRunResult> {
	const { provider, token, nativeArgs } = options;
	const spawner = options.spawner ?? defaultSpawner;

	const command = provider.nativeCli({ token, args: nativeArgs });

	let spawned: SpawnedPassthrough;

	try {
		spawned = spawner(command.argv, { ...process.env, ...command.env });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(
				`${command.argv[0]} CLI not found. Install it first (e.g. \`bun add -g ${command.argv[0]}\`).`,
			);
		}

		throw error;
	}

	return { exitCode: await spawned.exited };
}
