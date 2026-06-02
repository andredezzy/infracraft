import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as pulumi from "@pulumi/pulumi";

const DEFAULT_IGNORE = new Set([
	"node_modules",
	"dist",
	".turbo",
	".next",
	".git",
	".vercel",
]);

interface HashOptions {
	ignore?: Set<string>;
}

/**
 * Produces a stable SHA-256 hex digest for use as a resource/deploy trigger,
 * from either a source directory or an environment map.
 *
 * - **Directory** (`string`): recursively hashes file names + contents (build
 *   and VCS directories skipped). Synchronous — returns a plain `string`.
 * - **Env map** (`Record<string, Input<string>>`): resolves the values, sorts
 *   by key, and hashes them into a single non-secret `Output<string>`. Passing
 *   secret `Output`s straight into a dynamic resource's inputs intermittently
 *   races Pulumi's gRPC secret serialization (`Unexpected struct type`, issue
 *   #16041) — the reason such deploys otherwise need `--parallel 1`. Collapsing
 *   the env to one `unsecret` digest keeps the trigger moving on any change
 *   while carrying no secret, so deploys are safe to (re)create at full
 *   parallelism. Exposing the digest is safe: it is a one-way hash of
 *   high-entropy secrets.
 *
 * @param input A source directory path, or a map of env var name to value.
 * @param options Directory mode only: `ignore` overrides the default skip set.
 * @returns `string` for a directory, `Output<string>` for an env map.
 * @example
 * triggers: [hash(appDir), hash(env)]
 */
export function hash(directory: string, options?: HashOptions): string;
export function hash(
	env: Record<string, pulumi.Input<string>>,
): pulumi.Output<string>;
export function hash(
	input: string | Record<string, pulumi.Input<string>>,
	options?: HashOptions,
): string | pulumi.Output<string> {
	if (typeof input !== "string") {
		const keys = Object.keys(input).sort();

		return pulumi.unsecret(
			pulumi.all(keys.map((key) => input[key])).apply((values) => {
				const digest = crypto.createHash("sha256");

				for (const [index, key] of keys.entries()) {
					digest.update(`${key}=${values[index]}\0`);
				}

				return digest.digest("hex");
			}),
		);
	}

	const ignore = options?.ignore ?? DEFAULT_IGNORE;
	const digest = crypto.createHash("sha256");

	function walk(currentPath: string) {
		const entries = fs.readdirSync(currentPath, { withFileTypes: true });

		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (ignore.has(entry.name)) {
				continue;
			}

			const fullPath = path.join(currentPath, entry.name);

			if (entry.isDirectory()) {
				walk(fullPath);
			} else if (entry.isFile()) {
				digest.update(entry.name);
				digest.update(fs.readFileSync(fullPath));
			}
		}
	}

	walk(input);

	return digest.digest("hex");
}
