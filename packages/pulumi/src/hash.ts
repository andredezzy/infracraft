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

	hashDirInto(digest, input, ignore);

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

interface WorkspacePackage {
	name?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

function readWorkspacePackage(directory: string): WorkspacePackage | undefined {
	try {
		return JSON.parse(
			fs.readFileSync(path.join(directory, "package.json"), "utf8"),
		) as WorkspacePackage;
	} catch {
		return undefined;
	}
}

/**
 * Indexes every workspace package by its `package.json` `name` -> directory, by
 * scanning `apps/*` and `packages/*`. Robust to a package whose directory name
 * differs from its published name.
 */
function buildWorkspaceIndex(monorepoRoot: string): Map<string, string> {
	const index = new Map<string, string>();

	for (const group of ["apps", "packages"]) {
		const base = path.join(monorepoRoot, group);

		let entries: fs.Dirent[];

		try {
			entries = fs.readdirSync(base, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}

			const directory = path.join(base, entry.name);
			const pkg = readWorkspacePackage(directory);

			if (pkg?.name) {
				index.set(pkg.name, directory);
			}
		}
	}

	return index;
}

/**
 * Hashes an app's source AND every workspace package it depends on
 * (transitively), for use as a redeploy trigger. Resolving the dependency
 * closure from each `package.json` means a change to a shared `packages/*` an
 * app depends on correctly retriggers that app's deploy — and adding a new app
 * needs no hand-maintained list of which packages to hash.
 *
 * @param monorepoRoot Absolute repo root (holds `apps/` and `packages/`).
 * @param appDirectory The app to hash, relative to the root (e.g. `apps/api`).
 * @example
 * triggers: [hashApp(monorepoRoot, "apps/api"), hash(env)]
 */
export function hashApp(
	monorepoRoot: string,
	appDirectory: string,
	options?: HashOptions,
): string {
	const ignore = options?.ignore ?? DEFAULT_IGNORE;
	const index = buildWorkspaceIndex(monorepoRoot);

	const start = path.join(monorepoRoot, appDirectory);
	const visited = new Set<string>();
	const queue = [start];

	while (queue.length > 0) {
		const directory = queue.pop();

		if (!directory || visited.has(directory)) {
			continue;
		}

		visited.add(directory);

		const pkg = readWorkspacePackage(directory);

		if (!pkg) {
			continue;
		}

		const deps = { ...pkg.dependencies, ...pkg.devDependencies };

		for (const depName of Object.keys(deps)) {
			const depDirectory = index.get(depName);

			// Only workspace packages are in the index — external deps are ignored.
			if (depDirectory && !visited.has(depDirectory)) {
				queue.push(depDirectory);
			}
		}
	}

	const digest = crypto.createHash("sha256");

	// Sort by directory so the digest is independent of traversal order; include
	// the relative path so moving content between packages changes the hash.
	for (const directory of [...visited].sort()) {
		digest.update(`\0${path.relative(monorepoRoot, directory)}\0`);
		hashDirInto(digest, directory, ignore);
	}

	return digest.digest("hex");
}
