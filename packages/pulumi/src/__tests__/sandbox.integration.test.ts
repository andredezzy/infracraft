import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildSandboxScript, SandboxMode } from "../sandbox";

/**
 * Executable integration test: the unit tests assert the generated STRING; this
 * actually RUNS the script under /bin/sh against a throwaway git repo, so it
 * catches quoting, exit-code, `set -e`, awk-runtime, and rsync bugs that a
 * `toContain` assertion cannot. Skipped if git/rsync are unavailable.
 */
function hasTool(tool: string): boolean {
	try {
		execSync(`command -v ${tool}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const TOOLS = hasTool("git") && hasTool("rsync");

let repoDir: string;
let outDir: string;

beforeAll(() => {
	fs.mkdirSync("/tmp/infracraft", { recursive: true }); // DeploySandbox does this at runtime
	repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-repo-"));
	outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ic-out-"));

	const write = (rel: string, body: string) => {
		const full = path.join(repoDir, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, body);
	};
	write("apps/foo/index.ts", "export const foo = 1;\n");
	write("apps/foo/package.json", '{"name":"foo"}\n');
	write("apps/bar/index.ts", "export const bar = 2;\n");
	write("apps/bar/package.json", '{"name":"bar"}\n');
	write("packages/shared/util.ts", "export const u = 3;\n");
	write("README.md", "# root\n");

	const git = (a: string) =>
		execSync(`git ${a}`, {
			cwd: repoDir,
			stdio: "ignore",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
			},
		});
	git("init -q");
	git("add -A");
	git("commit -qm init");
});

afterAll(() => {
	fs.rmSync(repoDir, { recursive: true, force: true });
	fs.rmSync(outDir, { recursive: true, force: true });
});

/** Runs a generated script via `sh <file>` from `cwd`, returns nothing (throws on non-zero). */
function runScript(script: string, cwd: string): void {
	const file = path.join(outDir, "script.sh");
	fs.writeFileSync(file, script);
	execFileSync("sh", [file], {
		cwd,
		stdio: "pipe",
		env: { ...process.env, OUTDIR: outDir },
	});
}

describe.skipIf(!TOOLS)("buildSandboxScript (executed)", () => {
	it("STUB: isolates into /tmp/infracraft, honours excludePaths, stub .git has no commit, cleans up", () => {
		const script = buildSandboxScript({
			mode: SandboxMode.STUB,
			appName: "web",
			env: "test",
			excludePaths: ["apps/bar"],
			// Capture evidence OUT of the sandbox before the EXIT trap removes it.
			cli: '{ echo "CWD=$(pwd)"; echo "HEAD=$(git rev-parse HEAD 2>&1 || true)"; echo "FILES=$(git ls-files | sort | tr "\\n" ",")"; } > "$OUTDIR/manifest.txt"',
		});

		runScript(script, repoDir);

		const m = fs.readFileSync(path.join(outDir, "manifest.txt"), "utf8");
		// The CLI ran inside an isolated sandbox under the workspace root.
		expect(m).toMatch(/CWD=.*\/infracraft\/.*-test-web\./);
		// Stub .git is metadata-free: HEAD is unborn (no commit SHA reachable).
		expect(m).toMatch(/HEAD=.*(unknown revision|ambiguous argument|fatal)/i);
		// excludePaths honoured: bar's code dropped, its package.json kept.
		expect(m).toContain("apps/foo/index.ts");
		expect(m).toContain("apps/foo/package.json");
		expect(m).toContain("apps/bar/package.json");
		expect(m).toContain("packages/shared/util.ts");
		expect(m).toContain("README.md");
		expect(m).not.toContain("apps/bar/index.ts");

		// Sandbox removed by the EXIT trap (no leftover for this run's prefix).
		const leftovers = fs
			.readdirSync("/tmp/infracraft")
			.filter((d) => d.includes("-test-web."));
		expect(leftovers).toEqual([]);
	});

	it("aborts (non-zero) when run outside a git repository — `set -e` + guard", () => {
		const script = buildSandboxScript({
			mode: SandboxMode.STUB,
			appName: "web",
			cli: 'echo should-not-run > "$OUTDIR/should-not-exist.txt"',
		});
		// os.tmpdir() itself is not a git repo → `git rev-parse` fails → exit 1.
		expect(() => runScript(script, os.tmpdir())).toThrow();
		expect(fs.existsSync(path.join(outDir, "should-not-exist.txt"))).toBe(
			false,
		);
	});
});
