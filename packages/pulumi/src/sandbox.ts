/** Escapes a path literal for embedding inside an awk ERE. */
function escapeAwkRegex(path: string): string {
	return path.replace(/[.[\]{}()*+?^$|\\/]/g, "\\$&");
}

/**
 * Builds the shell filter applied to newline-delimited `git ls-files` output
 * before `rsync --files-from`. For `apps/<x>` it drops the app's files but keeps
 * `apps/<x>/package.json` (the monorepo workspace graph needs it during build);
 * any other entry drops the path and its subtree. Returns `cat` (passthrough)
 * when nothing is excluded. Uses awk so it is portable across macOS and Linux.
 */
export function buildSandboxFileFilter(excludePaths: string[] = []): string {
	if (excludePaths.length === 0) {
		return "cat";
	}

	const clauses = excludePaths.map((entry) => {
		const escaped = escapeAwkRegex(entry);

		if (entry.startsWith("apps/")) {
			return `!(/^${escaped}\\// && !/^${escaped}\\/package\\.json$/)`;
		}

		return `!/^${escaped}(\\/|$)/`;
	});

	return `awk '${clauses.join(" && ")}'`;
}
