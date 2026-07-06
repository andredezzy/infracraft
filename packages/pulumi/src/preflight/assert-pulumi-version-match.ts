import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

/** The Node SDK whose version must track the running Pulumi CLI. */
const SDK_PACKAGE = "@pulumi/pulumi";

/**
 * Outcome when the CLI and SDK versions disagree. A closed set, so it is an
 * enum rather than a string union (matches the `SandboxMode` precedent).
 */
export enum PulumiVersionMismatchMode {
	/** Fails the program at preflight (default). */
	THROW = "THROW",
	/** Logs and continues. */
	WARN = "WARN",
}

/** Options for {@link assertPulumiVersionMatch}. */
export interface PulumiVersionMatchOptions {
	/**
	 * What to do on a major.minor mismatch. `THROW` (default) fails the program
	 * at preflight; `WARN` logs and continues.
	 */
	mode?: PulumiVersionMismatchMode;

	/**
	 * Reads the running Pulumi CLI version string (e.g. `"v3.250.0"`). Injectable
	 * for tests; defaults to `spawnSync("pulumi", ["version"])`.
	 */
	readCliVersion?: () => string;

	/**
	 * Reads the installed `@pulumi/pulumi` SDK version, or `undefined` when it
	 * cannot be resolved. Injectable for tests; defaults to resolving the SDK's
	 * `package.json` from the program's working directory.
	 */
	readSdkVersion?: () => string | undefined;
}

/** Runs `pulumi version` and returns its raw stdout (e.g. `"v3.250.0\n"`). */
function spawnPulumiVersion(): string {
	const result = spawnSync("pulumi", ["version"], { encoding: "utf8" });

	if (result.error) {
		throw result.error;
	}

	if (result.status !== 0) {
		const detail = result.stderr?.trim() || "no output";

		throw new Error(`\`pulumi version\` exited ${result.status}: ${detail}`);
	}

	return result.stdout;
}

/**
 * Resolves the installed `@pulumi/pulumi` version from the program's working
 * directory (the SDK is a peer/dependency of the consuming program, not of
 * infracraft). Returns `undefined` when it cannot be resolved or read, so the
 * caller can treat the check as best-effort.
 */
function resolveSdkVersion(): string | undefined {
	try {
		const requireFromProgram = createRequire(
			path.join(process.cwd(), "package.json"),
		);

		const manifestPath = requireFromProgram.resolve(
			`${SDK_PACKAGE}/package.json`,
		);

		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			version?: string;
		};

		return manifest.version;
	} catch {
		return undefined;
	}
}

/** Extracts `"major.minor"` from a version string, tolerating a leading `v`, a
 * trailing patch/pre-release, and surrounding whitespace. */
function majorMinor(version: string): string {
	const cleaned = version.trim().replace(/^v/, "");
	const [major = "0", minor = "0"] = cleaned.split(".");

	return `${major}.${minor}`;
}

/**
 * Asserts that the running Pulumi CLI and the installed `@pulumi/pulumi` Node
 * SDK agree on their major.minor version.
 *
 * The CLI is the Go engine that marshals resource state; the SDK is the Node
 * serializer that produces it. When their versions skew, the two disagree on
 * the wire format — this session saw intermittent "Unexpected struct type"
 * marshal failures on dynamic resources traced to exactly such a CLI/SDK skew.
 * Verifying the pair up front turns a flaky mid-`up` crash into a clear
 * preflight message.
 *
 * Best-effort by design: when the SDK cannot be resolved from the program's
 * working directory (e.g. it is not installed as a direct dependency), the
 * check warns and returns rather than throwing — there is nothing to compare.
 *
 * Runs automatically: every infracraft provider constructor calls the
 * memoized {@link ensurePulumiVersionMatch}, so programs need no explicit
 * call. Call this directly only to run the check earlier than the first
 * provider, or to opt into `WARN` mode.
 *
 * @param options Mode override and injectable readers (see
 *   {@link PulumiVersionMatchOptions}).
 * @throws {Error} When the versions differ and `mode` is `THROW` (the default).
 * @example
 * ```typescript
 * import { assertPulumiVersionMatch } from "@infracraft/pulumi/preflight";
 *
 * assertPulumiVersionMatch();
 * ```
 */
export function assertPulumiVersionMatch(
	options: PulumiVersionMatchOptions = {},
): void {
	const mode = options.mode ?? PulumiVersionMismatchMode.THROW;
	const readCliVersion = options.readCliVersion ?? spawnPulumiVersion;
	const readSdkVersion = options.readSdkVersion ?? resolveSdkVersion;

	const sdkVersion = readSdkVersion();

	if (sdkVersion === undefined) {
		console.warn(
			`[infracraft] Skipping Pulumi CLI/SDK version check — could not resolve \`${SDK_PACKAGE}\` from ${process.cwd()}. Install it as a dependency of your Pulumi program to enable this preflight.`,
		);

		return;
	}

	const cliVersion = readCliVersion();

	if (majorMinor(cliVersion) === majorMinor(sdkVersion)) {
		return;
	}

	const cliClean = cliVersion.trim().replace(/^v/, "");
	const sdkClean = sdkVersion.trim().replace(/^v/, "");

	const message =
		`Pulumi version preflight: the \`pulumi\` CLI is ${cliClean} but ` +
		`the installed \`${SDK_PACKAGE}\` SDK is ${sdkClean} — a major.minor version ` +
		`mismatch. The Go engine (CLI) and the Node serializer (SDK) must agree — a ` +
		`skew causes intermittent "Unexpected struct type" marshal failures on ` +
		`dynamic resources. Align them, e.g. pin the CLI to the SDK version:\n` +
		`  curl -fsSL https://get.pulumi.com | sh -s -- --version ${sdkClean}`;

	if (mode === PulumiVersionMismatchMode.WARN) {
		console.warn(`[infracraft] ${message}`);

		return;
	}

	throw new Error(message);
}

let versionMatchEnsured = false;

/**
 * Memoized, best-effort {@link assertPulumiVersionMatch} — runs the check at
 * most once per process. Every infracraft provider constructor calls this, so
 * consuming programs get the CLI/SDK skew guard with zero ceremony; there is
 * no need to call anything at the top of a program.
 *
 * Best-effort beyond the SDK side: when the `pulumi` binary itself cannot be
 * run (not installed — e.g. a unit-test or CI environment that never touches
 * a real stack), the check warns and skips rather than failing provider
 * construction. A RESOLVED major.minor mismatch still throws.
 */
export function ensurePulumiVersionMatch(): void {
	if (versionMatchEnsured) {
		return;
	}

	// Only a real `pulumi up`/`preview` serializes resources through the
	// engine, and only there can a CLI/SDK skew corrupt the wire format. The
	// Node language host sets this env var when it launches the program;
	// outside it (unit tests, plain scripts) there is nothing to guard, and
	// throwing would couple test suites to the host machine's CLI.
	if (process.env.PULUMI_NODEJS_MONITOR === undefined) {
		return;
	}

	versionMatchEnsured = true;

	let cliVersion: string;

	try {
		cliVersion = spawnPulumiVersion();
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);

		console.warn(
			`[infracraft] Skipping Pulumi CLI/SDK version check — could not run \`pulumi version\`: ${detail}`,
		);

		return;
	}

	assertPulumiVersionMatch({ readCliVersion: () => cliVersion });
}
