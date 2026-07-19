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
	/** Directory walks only: entry names to skip. Overrides the default build/VCS skip set. */
	ignore?: Set<string>;
	/**
	 * When set, every path entry is labeled inside the digest by its path
	 * RELATIVE to this base (`\0<relative>\0` framing) before its content —
	 * so moving content between entries changes the hash, while absolute
	 * machine-specific prefixes never enter it. Callers hashing a multi-path
	 * collection should pass their stable root here.
	 */
	base?: string;
}

/**
 * Produces a stable SHA-256 hex digest for use as a resource/deploy trigger,
 * from filesystem paths or an environment map.
 *
 * - **Path(s)** (`string | string[]`): each entry may be a directory
 *   (recursively hashed: file names + contents, build and VCS directories
 *   skipped) or a single file (content; name when unlabeled). Entries fold
 *   into the digest in CALLER order — pass a sorted collection when order is
 *   not semantic. With `options.base`, each entry is prefixed by its relative
 *   path (see {@link HashOptions.base}). Synchronous — returns a plain
 *   `string`. A missing path throws: a trigger silently hashing nothing would
 *   mask the very changes it exists to detect.
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
 * @param input A path, an ordered collection of paths, or an env map.
 * @param options Path mode only: `ignore` and `base` — see {@link HashOptions}.
 * @returns `string` for paths, `Output<string>` for an env map.
 * @example
 * triggers: [hash(appDir), hash(env)]
 * @example
 * // A dependency closure the CALLER resolved, labeled relative to the root:
 * hash(closureDirectories.sort(), { base: monorepoRoot })
 */
export function hash(paths: string | string[], options?: HashOptions): string;
export function hash(
	env: Record<string, pulumi.Input<string>>,
): pulumi.Output<string>;
export function hash(
	input: string | string[] | Record<string, pulumi.Input<string>>,
	options?: HashOptions,
): string | pulumi.Output<string> {
	if (typeof input !== "string" && !Array.isArray(input)) {
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

	const entries = typeof input === "string" ? [input] : input;
	const ignore = options?.ignore ?? DEFAULT_IGNORE;
	const digest = crypto.createHash("sha256");

	for (const entry of entries) {
		if (options?.base !== undefined) {
			digest.update(`\0${path.relative(options.base, entry)}\0`);
		}

		const stats = fs.statSync(entry);

		if (stats.isDirectory()) {
			hashDirInto(digest, entry, ignore);
		} else if (options?.base !== undefined) {
			// The label above already identifies the file.
			digest.update(fs.readFileSync(entry));
		} else {
			// Unlabeled file: name + content, mirroring the walk's framing.
			digest.update(path.basename(entry));
			digest.update(fs.readFileSync(entry));
		}
	}

	return digest.digest("hex");
}

/** Recursively folds a directory's file names + contents into `digest`. */
function hashDirInto(
	digest: crypto.Hash,
	currentPath: string,
	ignore: Set<string>,
): void {
	const entries = fs.readdirSync(currentPath, { withFileTypes: true });

	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (ignore.has(entry.name)) {
			continue;
		}

		const fullPath = path.join(currentPath, entry.name);

		if (entry.isDirectory()) {
			hashDirInto(digest, fullPath, ignore);
		} else if (entry.isFile()) {
			digest.update(entry.name);
			digest.update(fs.readFileSync(fullPath));
		}
	}
}
