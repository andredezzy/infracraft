import { describe, expect, it, vi } from "vitest";
import {
	buildSandboxFileFilter,
	buildSandboxScript,
	DeploySandbox,
	isDeploySandbox,
} from "../sandbox";

vi.mock("@pulumi/pulumi", () => ({
	runtime: { isDryRun: vi.fn(() => false) },
	ComponentResource: class {
		constructor(
			public type: string,
			public name: string,
		) {}
		registerOutputs(_outputs?: unknown): void {}
	},
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		mkdirSync: vi.fn(),
		readdirSync: vi.fn(() => []),
		statSync: vi.fn(),
		rmSync: vi.fn(),
	};
});

describe("buildSandboxFileFilter", () => {
	it("is a passthrough when nothing is excluded", () => {
		expect(buildSandboxFileFilter()).toBe("cat");
		expect(buildSandboxFileFilter([])).toBe("cat");
	});

	it("drops a non-apps path and its subtree", () => {
		const filter = buildSandboxFileFilter(["docs"]);
		expect(filter).toContain("awk");
		expect(filter).toContain("!/^docs(\\/|$)/");
	});

	it("drops an app's code but keeps its package.json", () => {
		const filter = buildSandboxFileFilter(["apps/mesh"]);
		expect(filter).toContain("/^apps\\/mesh\\//");
		expect(filter).toContain("!/^apps\\/mesh\\/package\\.json$/");
	});

	it("ANDs every exclude clause into one awk program", () => {
		const filter = buildSandboxFileFilter(["apps/mesh", "docs"]);
		expect(filter.match(/&&/g)?.length).toBeGreaterThanOrEqual(1);
		expect(filter).toContain("apps\\/mesh");
		expect(filter).toContain("docs");
	});
});

describe("buildSandboxScript", () => {
	const base = { appName: "nexus", cli: "vercel deploy --prod --yes" };

	it("no-sandbox mode runs the cli in the live tree", () => {
		const script = buildSandboxScript({
			...base,
			sandbox: false,
			gitGuard: false,
		});
		expect(script).toContain("git rev-parse --show-toplevel");
		expect(script).toContain('cd "$REPO"');
		expect(script).toContain(base.cli);
		expect(script).not.toContain("mktemp");
	});

	it("stub mode filters the copy and builds a metadata-free stub .git", () => {
		const script = buildSandboxScript({
			...base,
			sandbox: true,
			gitGuard: true,
			excludePaths: ["apps/mesh"],
		});
		expect(script).toContain('PROJECT=$(basename "$REPO")');
		expect(script).toContain('mktemp -d "/tmp/infracraft/$PROJECT-nexus.');
		expect(script).toContain("trap 'rm -rf \"$SANDBOX\"' EXIT");
		expect(script).toContain('git -C "$REPO" ls-files');
		expect(script).toContain("apps\\/mesh"); // filter is applied
		expect(script).toContain("git init -q && git add -A");
		expect(script).not.toContain("cp -c -R"); // stub does not copy the real .git
	});

	it("prefixes the sandbox dir with the env when provided", () => {
		const script = buildSandboxScript({
			...base,
			sandbox: true,
			gitGuard: true,
			env: "staging",
		});
		expect(script).toContain(
			'mktemp -d "/tmp/infracraft/$PROJECT-staging-nexus.',
		);
	});

	it("original mode copies the full tree and CoW-copies the real .git (no filter)", () => {
		const script = buildSandboxScript({
			...base,
			sandbox: true,
			gitGuard: false,
			excludePaths: ["apps/mesh"],
		});
		expect(script).toContain('mktemp -d "/tmp/infracraft/$PROJECT-nexus.');
		expect(script).toContain(
			'cp -c -R "$REPO/.git" "$SANDBOX/.git" 2>/dev/null || cp -R "$REPO/.git" "$SANDBOX/.git"',
		);
		expect(script).not.toContain("git init"); // original keeps real history
		expect(script).not.toContain("apps\\/mesh"); // OFF does not filter
	});

	it("runs setup before the cli when provided", () => {
		const script = buildSandboxScript({
			...base,
			sandbox: true,
			gitGuard: true,
			setup: "printf x > railpack.json",
		});
		expect(script.indexOf("railpack.json")).toBeLessThan(
			script.indexOf(base.cli),
		);
	});
});

describe("DeploySandbox", () => {
	it("is recognised by isDeploySandbox (brand), not by structural luck", () => {
		const sandbox = new DeploySandbox("deploy-sandbox");
		expect(isDeploySandbox(sandbox)).toBe(true);
		expect(isDeploySandbox({})).toBe(false);
		expect(isDeploySandbox(null)).toBe(false);
	});

	it("prepares the workspace root on up", async () => {
		const fs = await import("node:fs");
		(fs.mkdirSync as ReturnType<typeof vi.fn>).mockClear();
		new DeploySandbox("deploy-sandbox");
		expect(fs.mkdirSync).toHaveBeenCalledWith("/tmp/infracraft", {
			recursive: true,
		});
	});

	it("does not touch the filesystem during preview (dry run)", async () => {
		const { runtime } = await import("@pulumi/pulumi");
		const fs = await import("node:fs");
		(runtime.isDryRun as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
		(fs.mkdirSync as ReturnType<typeof vi.fn>).mockClear();
		new DeploySandbox("deploy-sandbox");
		expect(fs.mkdirSync).not.toHaveBeenCalled();
	});
});
