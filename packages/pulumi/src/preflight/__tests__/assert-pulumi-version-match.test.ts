import { afterEach, describe, expect, it, vi } from "vitest";

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
