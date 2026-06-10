import { SandboxMode } from "@infracraft/sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", () => ({
	intro: vi.fn(),
	outro: vi.fn(),
	cancel: vi.fn(),
	isCancel: vi.fn(() => false),
	confirm: vi.fn(async () => true),
	log: {
		info: vi.fn(),
		success: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		message: vi.fn(),
	},
}));

import * as p from "@clack/prompts";
import { makeFakeProvider } from "../../providers/__tests__/fake-provider";
import type { DeployTargetCapability } from "../../providers/provider";
import { InteractionMode } from "../../registry/command-spec";
import type { DeployTargetPreflightContext } from "../deploy";
import {
	DeployTargetPreflightOutcome,
	ensureDeployTarget,
	splitDeployArgs,
} from "../deploy";

describe("splitDeployArgs", () => {
	const provider = makeFakeProvider();

	it("extracts gate-owned flags and passes the rest through", () => {
		const result = splitDeployArgs(provider, [
			"--prod",
			"--account",
			"work",
			"--force",
		]);

		expect(result.accountLabel).toBe("work");
		expect(result.mode).toBe(SandboxMode.STUB);
		expect(result.passthroughArgs).toEqual(["--prod", "--force"]);
	});

	it("supports -a, --no-sandbox, and --git-metadata", () => {
		expect(splitDeployArgs(provider, ["-a", "work"]).accountLabel).toBe("work");

		expect(splitDeployArgs(provider, ["--no-sandbox"]).mode).toBe(
			SandboxMode.NONE,
		);

		expect(splitDeployArgs(provider, ["--git-metadata"]).mode).toBe(
			SandboxMode.ORIGINAL,
		);
	});

	it("defaults to STUB with no account label", () => {
		const result = splitDeployArgs(provider, ["--prod"]);

		expect(result.accountLabel).toBeUndefined();
		expect(result.mode).toBe(SandboxMode.STUB);
		expect(result.passthroughArgs).toEqual(["--prod"]);
	});

	it("--no-sandbox after --git-metadata wins (last flag rules)", () => {
		expect(
			splitDeployArgs(provider, ["--git-metadata", "--no-sandbox"]).mode,
		).toBe(SandboxMode.NONE);
	});

	it("supports the --account=label equals form", () => {
		const result = splitDeployArgs(provider, ["--account=work", "--prod"]);

		expect(result.accountLabel).toBe("work");
		expect(result.passthroughArgs).toEqual(["--prod"]);
	});

	it("--git-metadata after --no-sandbox wins too", () => {
		expect(
			splitDeployArgs(provider, ["--no-sandbox", "--git-metadata"]).mode,
		).toBe(SandboxMode.ORIGINAL);
	});

	it("extracts --create-project and keeps it out of the passthrough", () => {
		const result = splitDeployArgs(provider, ["--create-project", "--prod"]);

		expect(result.createTarget).toBe(true);
		expect(result.passthroughArgs).toEqual(["--prod"]);
	});

	it("defaults createTarget to false", () => {
		expect(splitDeployArgs(provider, ["--prod"]).createTarget).toBe(false);
	});

	it("--create-project coexists with the other gate-owned flags", () => {
		const result = splitDeployArgs(provider, [
			"--account",
			"work",
			"--create-project",
			"--no-sandbox",
			"--prod",
		]);

		expect(result.accountLabel).toBe("work");
		expect(result.createTarget).toBe(true);
		expect(result.mode).toBe(SandboxMode.NONE);
		expect(result.passthroughArgs).toEqual(["--prod"]);
	});

	it("never extracts a reserved -a from deploy args (fly)", () => {
		const flyLike = makeFakeProvider({ reservedNativeFlags: ["-a"] });

		const result = splitDeployArgs(flyLike, ["-a", "my-app", "--image", "x"]);

		expect(result.accountLabel).toBeUndefined();
		expect(result.passthroughArgs).toEqual(["-a", "my-app", "--image", "x"]);
	});

	it("still extracts --account on a reserved-flag provider", () => {
		const flyLike = makeFakeProvider({ reservedNativeFlags: ["-a"] });

		const result = splitDeployArgs(flyLike, [
			"-a",
			"my-app",
			"--account",
			"work",
		]);

		expect(result.accountLabel).toBe("work");
		expect(result.passthroughArgs).toEqual(["-a", "my-app"]);
	});

	it("surfaces malformed gate flags", () => {
		const result = splitDeployArgs(provider, ["--account"]);

		expect(result.malformed).toContain("--account requires a value");
	});

	it("stops extracting deploy flags after --", () => {
		const result = splitDeployArgs(provider, ["--prod", "--", "--no-sandbox"]);

		expect(result.mode).toBe(SandboxMode.STUB);
		expect(result.passthroughArgs).toEqual(["--prod", "--", "--no-sandbox"]);
	});
});

function fakeTarget(
	overrides: Partial<DeployTargetCapability> = {},
): DeployTargetCapability {
	return {
		noun: "project",
		resolveName: () => "hat-rec",
		exists: vi.fn(async () => false),
		create: vi.fn(async () => {}),
		...overrides,
	};
}

function preflightContext(
	overrides: Partial<DeployTargetPreflightContext> = {},
): DeployTargetPreflightContext {
	return {
		deployTarget: fakeTarget(),
		token: "tok",
		identity: "andre",
		passthroughArgs: [],
		createTarget: false,
		interaction: InteractionMode.INTERACTIVE,
		...overrides,
	};
}

describe("ensureDeployTarget", () => {
	beforeEach(() => {
		vi.clearAllMocks();

		vi.mocked(p.confirm).mockResolvedValue(true);
		vi.mocked(p.isCancel).mockReturnValue(false);
	});

	afterEach(() => {
		process.exitCode = undefined;
	});

	it("is READY without a capability", async () => {
		const outcome = await ensureDeployTarget(
			preflightContext({ deployTarget: undefined }),
		);

		expect(outcome).toBe(DeployTargetPreflightOutcome.READY);
		expect(p.confirm).not.toHaveBeenCalled();
	});

	it("is READY when no target name resolves, without touching the API", async () => {
		const target = fakeTarget({ resolveName: () => undefined });

		const outcome = await ensureDeployTarget(
			preflightContext({ deployTarget: target }),
		);

		expect(outcome).toBe(DeployTargetPreflightOutcome.READY);
		expect(target.exists).not.toHaveBeenCalled();
	});

	it("is READY without a prompt when the target exists", async () => {
		const target = fakeTarget({ exists: vi.fn(async () => true) });

		const outcome = await ensureDeployTarget(
			preflightContext({ deployTarget: target }),
		);

		expect(outcome).toBe(DeployTargetPreflightOutcome.READY);
		expect(p.confirm).not.toHaveBeenCalled();
		expect(target.create).not.toHaveBeenCalled();
	});

	it("creates after a confirmed prompt and continues", async () => {
		const target = fakeTarget();

		const outcome = await ensureDeployTarget(
			preflightContext({ deployTarget: target }),
		);

		expect(p.confirm).toHaveBeenCalledWith({
			message: 'Project "hat-rec" was not found in scope andre. Create it?',
		});

		expect(target.create).toHaveBeenCalledWith("tok", "hat-rec");
		expect(p.log.success).toHaveBeenCalledWith('Created project "hat-rec"');
		expect(outcome).toBe(DeployTargetPreflightOutcome.READY);
	});

	it("aborts without creating when the prompt is declined", async () => {
		vi.mocked(p.confirm).mockResolvedValue(false);

		const target = fakeTarget();

		const outcome = await ensureDeployTarget(
			preflightContext({ deployTarget: target }),
		);

		expect(outcome).toBe(DeployTargetPreflightOutcome.ABORTED);
		expect(target.create).not.toHaveBeenCalled();
		expect(p.cancel).toHaveBeenCalledWith("Cancelled.");
	});

	it("--create-project creates without prompting", async () => {
		const target = fakeTarget();

		const outcome = await ensureDeployTarget(
			preflightContext({ deployTarget: target, createTarget: true }),
		);

		expect(p.confirm).not.toHaveBeenCalled();
		expect(target.create).toHaveBeenCalledWith("tok", "hat-rec");
		expect(outcome).toBe(DeployTargetPreflightOutcome.READY);
	});

	it("non-interactive misses fail fast with a hint", async () => {
		const target = fakeTarget();

		const outcome = await ensureDeployTarget(
			preflightContext({
				deployTarget: target,
				interaction: InteractionMode.NON_INTERACTIVE,
			}),
		);

		expect(outcome).toBe(DeployTargetPreflightOutcome.ABORTED);
		expect(p.confirm).not.toHaveBeenCalled();

		expect(p.log.error).toHaveBeenCalledWith(
			'Project "hat-rec" was not found in scope andre. Pass --create-project to create it, or create it first in the dashboard.',
		);

		expect(process.exitCode).toBe(1);
	});

	it("degrades to a warning when the existence check fails", async () => {
		const target = fakeTarget({
			exists: vi.fn(async () => {
				throw new Error("offline");
			}),
		});

		const outcome = await ensureDeployTarget(
			preflightContext({ deployTarget: target }),
		);

		expect(outcome).toBe(DeployTargetPreflightOutcome.READY);

		expect(p.log.warn).toHaveBeenCalledWith(
			'Could not verify project "hat-rec" exists (offline). Continuing with deploy.',
		);

		expect(p.confirm).not.toHaveBeenCalled();
	});
});
