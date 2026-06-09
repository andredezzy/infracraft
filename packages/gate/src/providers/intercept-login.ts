import { existsSync, unlinkSync } from "node:fs";

import { atomicWriteFile, readTextFile } from "./auth-file";
import type { ProviderSession } from "./provider";

/** The slice of GateProvider the interception choreography needs. */
export interface LoginTarget {
	name: string;
	authFile: string;
	loginArgv: string[];
	readNativeSession(): ProviderSession | null;
}

/** Spawns the native login with inherited stdio; resolves with its exit code. */
export type LoginSpawner = (argv: string[]) => Promise<number>;

const defaultSpawner: LoginSpawner = async (argv) => {
	const child = Bun.spawn(argv, {
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});

	return child.exited;
};

/**
 * The vergate interception dance, generalized: hold the native auth file aside
 * so the native browser login mints a FRESH session, capture it, then restore
 * whatever was there before. The user's current native login is never lost.
 */
export async function interceptNativeLogin(
	target: LoginTarget,
	spawner: LoginSpawner = defaultSpawner,
): Promise<ProviderSession> {
	const original = readTextFile(target.authFile);

	if (existsSync(target.authFile)) {
		unlinkSync(target.authFile);
	}

	const restore = (): void => {
		if (original !== null) {
			atomicWriteFile(target.authFile, original);
		} else if (existsSync(target.authFile)) {
			unlinkSync(target.authFile);
		}
	};

	let exitCode: number;

	try {
		exitCode = await spawner(target.loginArgv);
	} catch (error) {
		restore();

		throw error;
	}

	if (exitCode !== 0) {
		restore();

		throw new Error(`${target.name} login failed (exit code ${exitCode}).`);
	}

	const session = target.readNativeSession();

	restore();

	if (!session) {
		throw new Error(`Could not read a ${target.name} session after login.`);
	}

	return session;
}
