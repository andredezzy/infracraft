import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runtime } from "@pulumi/pulumi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	ensureGitignore,
	GUARD_DIR,
	gitGuard,
	hideGit,
	LEGACY_GUARD_DIRS,
	recoverStaleGuard,
	restoreGit,
} from "../git-guard";

// Delegates to the real `git` binary by default so repo setup works, but lets a
// single test force `git init` to fail and exercise hideGit's rollback path.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();

	return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

// `gitGuard` constructs a `command.local.Command` and reads `runtime.isDryRun()`.
// Neither needs a real Pulumi engine for these tests: the Command is a dependency
// anchor (the real hide is synchronous) and the dry-run flag is the only branch.
vi.mock("@pulumi/command", () => ({
	local: {
		Command: class {
			constructor(
				public name: string,
				public args: unknown,
			) {}
		},
	},
}));

vi.mock("@pulumi/pulumi", () => ({
	runtime: { isDryRun: vi.fn(() => false) },
}));

const LEGACY_GUARD_DIR = LEGACY_GUARD_DIRS[0];

const createdDirs: string[] = [];

/** A temp directory with a real, populated `.git` and a `MARKER` file inside it. */
function makeRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitguard-repo-"));
	createdDirs.push(dir);

	execFileSync("git", ["init", "--quiet"], { cwd: dir, stdio: "ignore" });

	fs.writeFileSync(path.join(dir, "app.ts"), "export const value = 1;\n");
	execFileSync("git", ["add", "app.ts"], { cwd: dir, stdio: "ignore" });

	// Marks this specific `.git` as the real one so we can prove it was preserved.
	fs.writeFileSync(path.join(dir, ".git", "MARKER"), "real");

	return dir;
}

/** A temp directory with no `.git` at all. */
function makeEmptyDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitguard-empty-"));
	createdDirs.push(dir);

	return dir;
}

function gitListedFiles(dir: string): string {
	return execFileSync("git", ["ls-files"], { cwd: dir }).toString().trim();
}

function read(dir: string, ...segments: string[]): string {
	return fs.readFileSync(path.join(dir, ...segments), "utf-8");
}

function exists(dir: string, ...segments: string[]): boolean {
	return fs.existsSync(path.join(dir, ...segments));
}

afterEach(() => {
	while (createdDirs.length > 0) {
		const dir = createdDirs.pop();

		if (dir) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	vi.mocked(runtime.isDryRun).mockReturnValue(false);
});

describe("hideGit", () => {
	it("moves the real history aside and leaves a stub that still lists tracked files", () => {
		const dir = makeRepo();

		hideGit(dir);

		expect(read(dir, GUARD_DIR, "MARKER")).toBe("real");
		expect(exists(dir, ".git", "MARKER")).toBe(false);
		expect(gitListedFiles(dir)).toContain("app.ts");
	});

	it("is a no-op when there is no .git to hide", () => {
		const dir = makeEmptyDir();

		hideGit(dir);

		expect(exists(dir, GUARD_DIR)).toBe(false);
		expect(exists(dir, ".git")).toBe(false);
	});

	it("does not clobber an existing guard dir (data-loss guard)", () => {
		const dir = makeRepo();

		fs.mkdirSync(path.join(dir, GUARD_DIR));
		fs.writeFileSync(path.join(dir, GUARD_DIR, "KEEP"), "precious");

		hideGit(dir);

		expect(read(dir, GUARD_DIR, "KEEP")).toBe("precious");
		expect(read(dir, ".git", "MARKER")).toBe("real");
	});

	it("rolls back (re-exposes the real .git) when git init fails", () => {
		const dir = makeRepo();

		vi.mocked(execFileSync).mockImplementationOnce(() => {
			throw new Error("git not found");
		});

		expect(() => hideGit(dir)).toThrow(/Failed to create stub \.git/);

		// The real history must be back in place, not stranded in the guard dir.
		expect(read(dir, ".git", "MARKER")).toBe("real");
		expect(exists(dir, GUARD_DIR)).toBe(false);
	});

	it("re-hides .git on a second up (regression: static trigger skipped re-runs)", () => {
		const dir = makeRepo();

		hideGit(dir);
		expect(exists(dir, GUARD_DIR)).toBe(true);

		restoreGit(dir);
		expect(exists(dir, GUARD_DIR)).toBe(false);
		expect(read(dir, ".git", "MARKER")).toBe("real");

		hideGit(dir);
		expect(read(dir, GUARD_DIR, "MARKER")).toBe("real");
		expect(exists(dir, ".git", "MARKER")).toBe(false);
	});
});

describe("restoreGit", () => {
	it("restores the real .git from the guard dir and discards the stub", () => {
		const dir = makeRepo();

		hideGit(dir);
		restoreGit(dir);

		expect(exists(dir, GUARD_DIR)).toBe(false);
		expect(read(dir, ".git", "MARKER")).toBe("real");
		expect(gitListedFiles(dir)).toContain("app.ts");
	});

	it("is a no-op when there is no guard dir to restore", () => {
		const dir = makeRepo();

		expect(() => restoreGit(dir)).not.toThrow();
		expect(read(dir, ".git", "MARKER")).toBe("real");
	});

	it("is idempotent — a second restore after the guard is gone is a safe no-op", () => {
		const dir = makeRepo();

		hideGit(dir);
		restoreGit(dir);

		// The SIGINT/SIGTERM handlers restore and then exit, which fires the `exit`
		// handler and restores again; the second call must not disturb the repo.
		restoreGit(dir);

		expect(exists(dir, GUARD_DIR)).toBe(false);
		expect(read(dir, ".git", "MARKER")).toBe("real");
	});
});

describe("recoverStaleGuard", () => {
	it("recovers a guard dir left by a crashed run, preserving real history", () => {
		const dir = makeRepo();

		// Simulate a run that was hard-killed after hiding but before restoring.
		hideGit(dir);

		const recovered = recoverStaleGuard(dir);

		expect(recovered).toBe(true);
		expect(exists(dir, GUARD_DIR)).toBe(false);
		expect(read(dir, ".git", "MARKER")).toBe("real");
		expect(gitListedFiles(dir)).toContain("app.ts");
	});

	it("recovers a guard dir left under a legacy (infrakit) name", () => {
		const dir = makeEmptyDir();

		fs.mkdirSync(path.join(dir, LEGACY_GUARD_DIR));
		fs.writeFileSync(path.join(dir, LEGACY_GUARD_DIR, "MARKER"), "real");

		fs.mkdirSync(path.join(dir, ".git"));
		fs.writeFileSync(path.join(dir, ".git", "STUB"), "throwaway");

		const recovered = recoverStaleGuard(dir);

		expect(recovered).toBe(true);
		expect(exists(dir, LEGACY_GUARD_DIR)).toBe(false);
		expect(read(dir, ".git", "MARKER")).toBe("real");
		expect(exists(dir, ".git", "STUB")).toBe(false);
	});

	it("is a no-op when there is no guard dir", () => {
		const dir = makeRepo();

		const recovered = recoverStaleGuard(dir);

		expect(recovered).toBe(false);
		expect(read(dir, ".git", "MARKER")).toBe("real");
	});
});

describe("gitGuard", () => {
	it("does not move .git during pulumi preview (dry run)", () => {
		vi.mocked(runtime.isDryRun).mockReturnValue(true);
		const dir = makeRepo();

		gitGuard(dir);

		expect(exists(dir, GUARD_DIR)).toBe(false);
		expect(read(dir, ".git", "MARKER")).toBe("real");
	});

	it("hides .git on up and restores it when the process exits (deploy success or failure)", () => {
		vi.mocked(runtime.isDryRun).mockReturnValue(false);

		const handlers: Record<string, () => void> = {};

		const onSpy = vi
			.spyOn(process, "on")
			.mockImplementation((event: string, handler: never) => {
				handlers[event] = handler;

				return process;
			});

		const dir = makeRepo();

		try {
			gitGuard(dir);

			expect(exists(dir, GUARD_DIR)).toBe(true);
			expect(exists(dir, ".git", "MARKER")).toBe(false);

			// The Pulumi host fires `exit` after every resource op completes —
			// whether the deploys succeeded or one of them failed.
			handlers.exit();

			expect(exists(dir, GUARD_DIR)).toBe(false);
			expect(read(dir, ".git", "MARKER")).toBe("real");
		} finally {
			onSpy.mockRestore();
		}
	});

	it("guards a root only once per process (no duplicate handlers, no self-undo)", () => {
		vi.mocked(runtime.isDryRun).mockReturnValue(false);

		const exitHandlers: Array<() => void> = [];

		const onSpy = vi
			.spyOn(process, "on")
			.mockImplementation((event: string, handler: never) => {
				if (event === "exit") {
					exitHandlers.push(handler);
				}

				return process;
			});

		const dir = makeRepo();

		try {
			gitGuard(dir);
			gitGuard(dir);

			// A second call for the same root must not re-run recovery (which would
			// treat our own guard as stale) nor register a second exit handler.
			expect(exitHandlers.length).toBe(1);
			expect(read(dir, GUARD_DIR, "MARKER")).toBe("real");
			expect(exists(dir, ".git", "MARKER")).toBe(false);
		} finally {
			onSpy.mockRestore();
		}
	});

	it("self-heals a stale guard dir before hiding on the next up", () => {
		vi.mocked(runtime.isDryRun).mockReturnValue(false);

		const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

		const dir = makeRepo();

		try {
			// Leftover guard from a previously crashed run.
			hideGit(dir);

			gitGuard(dir);

			// Recovered, then re-hidden: real history is back in the guard dir and
			// the working tree once again has a stub.
			expect(read(dir, GUARD_DIR, "MARKER")).toBe("real");
			expect(exists(dir, ".git", "MARKER")).toBe(false);
		} finally {
			onSpy.mockRestore();
		}
	});
});

describe("ensureGitignore", () => {
	let tmpDir: string;
	let gitignorePath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitguard-test-"));
		gitignorePath = path.join(tmpDir, ".gitignore");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates .gitignore with guard dir if file does not exist", () => {
		ensureGitignore(gitignorePath);

		const content = fs.readFileSync(gitignorePath, "utf-8");
		expect(content).toContain(GUARD_DIR);
	});

	it("appends guard dir to existing .gitignore", () => {
		fs.writeFileSync(gitignorePath, "node_modules\ndist\n");

		ensureGitignore(gitignorePath);

		const content = fs.readFileSync(gitignorePath, "utf-8");
		expect(content).toContain("node_modules");
		expect(content).toContain(GUARD_DIR);
	});

	it("does not duplicate guard dir if already present", () => {
		fs.writeFileSync(gitignorePath, `node_modules\n${GUARD_DIR}\n`);

		ensureGitignore(gitignorePath);

		const content = fs.readFileSync(gitignorePath, "utf-8");
		const occurrences = content.split(GUARD_DIR).length - 1;
		expect(occurrences).toBe(1);
	});

	it("adds newline before guard dir when file lacks trailing newline", () => {
		fs.writeFileSync(gitignorePath, "node_modules");

		ensureGitignore(gitignorePath);

		const content = fs.readFileSync(gitignorePath, "utf-8");
		expect(content).toBe(`node_modules\n${GUARD_DIR}\n`);
	});
});
