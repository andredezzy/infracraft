import { describe, expect, it } from "vitest";
import { buildSandboxFileFilter, buildSandboxScript } from "../sandbox";

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
		expect(script).toContain("mktemp -d /tmp/infracraft/nexus.");
		expect(script).toContain("trap 'rm -rf \"$SANDBOX\"' EXIT");
		expect(script).toContain('git -C "$REPO" ls-files');
		expect(script).toContain("apps\\/mesh"); // filter is applied
		expect(script).toContain("git init -q && git add -A");
		expect(script).not.toContain("cp -c -R"); // stub does not copy the real .git
	});

	it("original mode copies the full tree and CoW-copies the real .git (no filter)", () => {
		const script = buildSandboxScript({
			...base,
			sandbox: true,
			gitGuard: false,
			excludePaths: ["apps/mesh"],
		});
		expect(script).toContain("mktemp -d /tmp/infracraft/nexus.");
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
