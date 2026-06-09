import { describe, expect, it, vi } from "vitest";
import { DeploySandbox, isDeploySandbox } from "../sandbox";

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

	it("GCs a stale sandbox older than the threshold, keeps a fresh one", async () => {
		const fs = await import("node:fs");
		const now = Date.now();

		(fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValueOnce([
			"acme-staging-api.OLD",
			"acme-staging-worker.NEW",
		]);

		(fs.statSync as ReturnType<typeof vi.fn>).mockImplementation(
			(p: string) => ({
				mtimeMs: p.endsWith(".OLD") ? now - 5 * 60 * 60 * 1000 : now,
			}),
		);

		(fs.rmSync as ReturnType<typeof vi.fn>).mockClear();
		new DeploySandbox("deploy-sandbox");
		expect(fs.rmSync).toHaveBeenCalledTimes(1);

		expect(fs.rmSync).toHaveBeenCalledWith(
			"/tmp/infracraft/acme-staging-api.OLD",
			{ recursive: true, force: true },
		);
	});
});
