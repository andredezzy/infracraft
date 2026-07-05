import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCredential } from "../resolve-credential";

describe("resolveCredential", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("returns the direct value when one is configured", () => {
		expect(resolveCredential("direct-tok", undefined)).toBe("direct-tok");
	});

	it("prefers the direct value over the env var", () => {
		vi.stubEnv("INFRACRAFT_TEST_CREDENTIAL", "env-tok");

		expect(resolveCredential("direct-tok", "INFRACRAFT_TEST_CREDENTIAL")).toBe(
			"direct-tok",
		);
	});

	it("resolves the value of the named env var when no direct value exists", () => {
		vi.stubEnv("INFRACRAFT_TEST_CREDENTIAL", "env-tok");

		expect(resolveCredential(undefined, "INFRACRAFT_TEST_CREDENTIAL")).toBe(
			"env-tok",
		);
	});

	it("throws a loud error naming the env var when it is unset", () => {
		expect(() =>
			resolveCredential(undefined, "INFRACRAFT_TEST_CREDENTIAL_UNSET"),
		).toThrow(
			"provider credential env var INFRACRAFT_TEST_CREDENTIAL_UNSET is not set in the Pulumi execution environment",
		);
	});

	it("throws a loud error naming the env var when it is set but empty", () => {
		vi.stubEnv("INFRACRAFT_TEST_CREDENTIAL", "");

		expect(() =>
			resolveCredential(undefined, "INFRACRAFT_TEST_CREDENTIAL"),
		).toThrow(
			"provider credential env var INFRACRAFT_TEST_CREDENTIAL is not set in the Pulumi execution environment",
		);
	});

	it("throws when neither a value nor an env var name was configured", () => {
		expect(() => resolveCredential(undefined, undefined)).toThrow(
			"provider credential is missing",
		);
	});
});
