import type { SpawnSyncReturns } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	assertPulumiVersionMatch,
	PulumiVersionMismatchMode,
} from "../assert-pulumi-version-match";

describe("assertPulumiVersionMatch", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("passes when the CLI and SDK share a major.minor (ignoring patch and leading v)", () => {
		expect(() =>
			assertPulumiVersionMatch({
				readCliVersion: () => "v3.250.0\n",
				readSdkVersion: () => "3.250.9",
			}),
		).not.toThrow();
	});

	it("throws by default on a mismatch, naming BOTH versions and the fix command", () => {
		let message = "";

		try {
			assertPulumiVersionMatch({
				readCliVersion: () => "v3.250.0",
				readSdkVersion: () => "3.243.0",
			});
		} catch (error) {
			message = (error as Error).message;
		}

		expect(message).toContain("3.250.0");
		expect(message).toContain("3.243.0");

		expect(message).toContain(
			"curl -fsSL https://get.pulumi.com | sh -s -- --version 3.243.0",
		);
	});

	it("warns instead of throwing on a mismatch when mode is WARN", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(() =>
			assertPulumiVersionMatch({
				mode: PulumiVersionMismatchMode.WARN,
				readCliVersion: () => "v3.250.0",
				readSdkVersion: () => "3.243.0",
			}),
		).not.toThrow();

		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0][0]).toContain("mismatch");
	});

	it("warns and skips (never throws) when the SDK version cannot be resolved", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const readCliVersion = vi.fn(() => "v3.250.0");

		expect(() =>
			assertPulumiVersionMatch({
				readCliVersion,
				readSdkVersion: () => undefined,
			}),
		).not.toThrow();

		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0][0]).toContain("@pulumi/pulumi");
		expect(readCliVersion).not.toHaveBeenCalled();
	});
});

describe("ensurePulumiVersionMatch", () => {
	/** The workspace's real SDK version — the default reader resolves this. */
	const sdkVersion = createRequire(import.meta.url)(
		"@pulumi/pulumi/package.json",
	).version as string;

	beforeEach(() => {
		vi.resetModules();
		vi.stubEnv("PULUMI_NODEJS_MONITOR", "127.0.0.1:1");
	});

	afterEach(() => {
		vi.doUnmock("node:child_process");
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	/** Imports a fresh module instance whose `pulumi version` returns `result`. */
	async function importWithCli(result: Partial<SpawnSyncReturns<string>>) {
		const spawnSync = vi.fn(() => result);

		vi.doMock("node:child_process", () => ({ spawnSync }));

		const module = await import("../assert-pulumi-version-match");

		return { module, spawnSync };
	}

	it("runs the check once and memoizes subsequent calls", async () => {
		const { module, spawnSync } = await importWithCli({
			status: 0,
			stdout: `v${sdkVersion}\n`,
			stderr: "",
		});

		module.ensurePulumiVersionMatch();
		module.ensurePulumiVersionMatch();
		module.ensurePulumiVersionMatch();

		expect(spawnSync).toHaveBeenCalledTimes(1);
	});

	it("warns and skips when the pulumi binary cannot run, instead of throwing", async () => {
		const { module } = await importWithCli({
			error: new Error("spawn pulumi ENOENT"),
		});

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(() => module.ensurePulumiVersionMatch()).not.toThrow();

		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("could not run `pulumi version`"),
		);
	});

	it("still throws on a resolved major.minor mismatch", async () => {
		const { module } = await importWithCli({
			status: 0,
			stdout: "v0.1.0\n",
			stderr: "",
		});

		expect(() => module.ensurePulumiVersionMatch()).toThrow(
			/major\.minor version/,
		);
	});

	it("no-ops outside a real Pulumi run (engine env absent)", async () => {
		vi.unstubAllEnvs();

		const { module, spawnSync } = await importWithCli({
			status: 0,
			stdout: "v0.1.0\n",
			stderr: "",
		});

		expect(() => module.ensurePulumiVersionMatch()).not.toThrow();
		expect(spawnSync).not.toHaveBeenCalled();
	});
});
