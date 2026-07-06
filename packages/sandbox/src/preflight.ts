import { spawnSync } from "node:child_process";

/** Friendly install hints for the host binaries infracraft deploys rely on. */
const INSTALL_HINTS: Record<string, string> = {
	git: "install via your package manager (`brew install git`, `apt install git`) or the Xcode Command Line Tools (`xcode-select --install`)",
	rsync:
		"install via your package manager (`brew install rsync`, `apt install rsync`)",
	awk: "part of every POSIX base system — if it is missing, your PATH is likely broken",
	mktemp:
		"part of every POSIX base system — if it is missing, your PATH is likely broken",
	node: "install from https://nodejs.org or via a version manager (`fnm`, `nvm`, `mise`)",
	railway:
		"install the Railway CLI (`npm install -g @railway/cli` or `brew install railway`)",
	vercel: "install the Vercel CLI (`npm install -g vercel`)",
	fly: "install the Fly CLI (`brew install flyctl` or `curl -L https://fly.io/install.sh | sh`)",
};

/**
 * True when `binary` resolves on the host PATH. Uses POSIX `command -v` (a
 * shell builtin, so it needs a shell); the binary name rides in as a positional
 * parameter so nothing in it is ever parsed as shell syntax.
 */
function isOnHostPath(binary: string): boolean {
	const result = spawnSync(
		"/bin/sh",
		["-c", 'command -v -- "$1"', "sh", binary],
		{
			stdio: "ignore",
		},
	);

	return result.status === 0;
}

/**
 * Asserts that every listed binary resolves on the host PATH.
 *
 * Throws a single error naming ALL missing binaries (with an install hint for
 * each known one), so a deploy fails fast with actionable guidance instead of
 * dying midway through a shell script with an opaque "command not found".
 *
 * Recommended preflight before constructing deploy resources — e.g.
 * `assertHostBinaries(["git", "rsync", "awk", "mktemp", "fly"])` at the top of
 * a Pulumi program that uses `fly.Deploy`.
 */
export function assertHostBinaries(binaries: string[]): void {
	const missing = binaries.filter((binary) => !isOnHostPath(binary));

	if (missing.length === 0) {
		return;
	}

	const lines = missing.map((binary) => {
		const hint = INSTALL_HINTS[binary];

		return hint ? `  - ${binary}: ${hint}` : `  - ${binary}`;
	});

	throw new Error(`Missing required host binaries:\n${lines.join("\n")}`);
}
