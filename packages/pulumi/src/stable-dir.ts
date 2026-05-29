import * as path from "node:path";

/**
 * Converts an absolute working-directory path into one that is stable across
 * machines and CI, for use as a `command.local.Command` `dir` (or trigger value).
 *
 * `command.local.Command` stores `dir` verbatim in stack state. Because Pulumi
 * re-runs a command's `create` whenever an input changes — and replaces the
 * resource when a `triggers` value changes — an absolute path such as
 * `/Users/alice/repo`, which differs on every machine and on CI, makes every
 * command needlessly re-run (or replace) the first time the stack is applied
 * from a different checkout location.
 *
 * Returning the path relative to the Pulumi program's working directory yields
 * an identical value everywhere (typically `..`). The command provider resolves
 * a relative `dir` against the same program working directory the Pulumi host
 * runs in, so the value is self-consistent: it points at the same location at
 * execution time regardless of where the repository is checked out.
 *
 * @param absolutePath - Absolute filesystem path (e.g. the monorepo root)
 * @returns The path relative to the Pulumi program's working directory, or `"."` when they are identical
 *
 * @example
 * ```ts
 * // Pulumi program runs from `infrastructure/`; the monorepo root is its parent.
 * stableDir("/Users/alice/code/repo"); // => ".."
 * stableDir(process.cwd());            // => "."
 * ```
 */
export function stableDir(absolutePath: string): string {
	const relative = path.relative(process.cwd(), path.resolve(absolutePath));

	return relative === "" ? "." : relative;
}
