import { SandboxMode } from "@infracraft/sandbox";
import { describe, expect, it } from "vitest";

import { splitDeployArgs } from "../deploy";

describe("splitDeployArgs", () => {
	it("extracts gate-owned flags and passes the rest through", () => {
		const result = splitDeployArgs(["--prod", "--account", "work", "--force"]);

		expect(result.accountLabel).toBe("work");
		expect(result.mode).toBe(SandboxMode.STUB);
		expect(result.passthroughArgs).toEqual(["--prod", "--force"]);
	});

	it("supports -a, --no-sandbox, and --git-metadata", () => {
		expect(splitDeployArgs(["-a", "work"]).accountLabel).toBe("work");
		expect(splitDeployArgs(["--no-sandbox"]).mode).toBe(SandboxMode.NONE);
		expect(splitDeployArgs(["--git-metadata"]).mode).toBe(SandboxMode.ORIGINAL);
	});

	it("defaults to STUB with no account label", () => {
		const result = splitDeployArgs(["--prod"]);

		expect(result.accountLabel).toBeUndefined();
		expect(result.mode).toBe(SandboxMode.STUB);
		expect(result.passthroughArgs).toEqual(["--prod"]);
	});

	it("--no-sandbox after --git-metadata wins (last flag rules)", () => {
		expect(splitDeployArgs(["--git-metadata", "--no-sandbox"]).mode).toBe(
			SandboxMode.NONE,
		);
	});

	it("supports the --account=label equals form", () => {
		const result = splitDeployArgs(["--account=work", "--prod"]);

		expect(result.accountLabel).toBe("work");
		expect(result.passthroughArgs).toEqual(["--prod"]);
	});

	it("--git-metadata after --no-sandbox wins too", () => {
		expect(splitDeployArgs(["--no-sandbox", "--git-metadata"]).mode).toBe(
			SandboxMode.ORIGINAL,
		);
	});
});
