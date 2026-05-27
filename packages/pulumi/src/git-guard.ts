import * as fs from "node:fs";
import * as path from "node:path";
import * as command from "@pulumi/command";

export const GUARD_DIR = ".git-infrakit-pulumi-guard";

interface GitGuardResult {
	hide: command.local.Command;
}

export function gitGuard(monorepoRoot: string): GitGuardResult {
	const gitPath = path.join(monorepoRoot, ".git");
	const guardPath = path.join(monorepoRoot, GUARD_DIR);
	const gitignorePath = path.join(monorepoRoot, ".gitignore");

	ensureGitignore(gitignorePath);

	function restore(): void {
		try {
			if (fs.existsSync(guardPath)) {
				if (fs.existsSync(gitPath)) {
					fs.rmSync(gitPath, { recursive: true, force: true });
				}

				fs.renameSync(guardPath, gitPath);
			}
		} catch {
			console.error(
				`[git-guard] Failed to restore .git. Run manually: rm -rf ${gitPath} && mv ${guardPath} ${gitPath}`,
			);
		}
	}

	process.on("exit", restore);
	process.on("SIGINT", () => { restore(); process.exit(0); });
	process.on("SIGTERM", () => { restore(); process.exit(0); });

	const hide = new command.local.Command("git-guard-hide", {
		create: [
			`test -d .git && test ! -d ${GUARD_DIR}`,
			`&& mv .git ${GUARD_DIR}`,
			`&& git init --quiet`,
			`&& cp ${GUARD_DIR}/index .git/index`,
			`&& echo "hidden"`,
			`|| echo "no-op"`,
		].join(" "),
		dir: monorepoRoot,
		triggers: [monorepoRoot],
	});

	return { hide };
}

export function ensureGitignore(gitignorePath: string): void {
	const content = fs.existsSync(gitignorePath)
		? fs.readFileSync(gitignorePath, "utf-8")
		: "";

	if (content.includes(GUARD_DIR)) {
		return;
	}

	const newline = content.length > 0 && !content.endsWith("\n") ? "\n" : "";

	fs.appendFileSync(gitignorePath, `${newline}${GUARD_DIR}\n`);
}
