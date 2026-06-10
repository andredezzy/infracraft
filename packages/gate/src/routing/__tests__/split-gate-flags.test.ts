import { describe, expect, it } from "vitest";

import { makeFakeProvider } from "../../providers/__tests__/fake-provider";
import { GateFlagRegion, splitGateFlags } from "../split-gate-flags";

const vercelLike = makeFakeProvider();
const flyLike = makeFakeProvider({ reservedNativeFlags: ["-a"] });

const targeting = makeFakeProvider({
	passthroughTarget: {
		flag: "--project",
		noun: "project",
		resolveEnv: async () => ({}),
	},
});

describe("splitGateFlags WITH_LEADING_SLOT", () => {
	it("extracts --account and --account= anywhere", () => {
		expect(
			splitGateFlags(
				vercelLike,
				["env", "pull", "--account", "work"],
				GateFlagRegion.WITH_LEADING_SLOT,
			),
		).toEqual({
			accountLabel: "work",
			targetName: undefined,
			nativeArgs: ["env", "pull"],
			malformed: undefined,
		});

		expect(
			splitGateFlags(
				vercelLike,
				["--account=work", "env", "pull"],
				GateFlagRegion.WITH_LEADING_SLOT,
			),
		).toEqual({
			accountLabel: "work",
			targetName: undefined,
			nativeArgs: ["env", "pull"],
			malformed: undefined,
		});
	});

	it("extracts -a anywhere when not reserved", () => {
		const split = splitGateFlags(
			vercelLike,
			["env", "pull", "-a", "work"],
			GateFlagRegion.WITH_LEADING_SLOT,
		);

		expect(split.accountLabel).toBe("work");
		expect(split.nativeArgs).toEqual(["env", "pull"]);
	});

	it("extracts a reserved -a only in the leading slot", () => {
		const leading = splitGateFlags(
			flyLike,
			["-a", "work", "status", "-a", "my-app"],
			GateFlagRegion.WITH_LEADING_SLOT,
		);

		expect(leading.accountLabel).toBe("work");
		expect(leading.nativeArgs).toEqual(["status", "-a", "my-app"]);

		const nativeOnly = splitGateFlags(
			flyLike,
			["status", "-a", "my-app"],
			GateFlagRegion.WITH_LEADING_SLOT,
		);

		expect(nativeOnly.accountLabel).toBeUndefined();
		expect(nativeOnly.nativeArgs).toEqual(["status", "-a", "my-app"]);
	});

	it("keeps a mid-args -- and stops parsing at it", () => {
		const split = splitGateFlags(
			vercelLike,
			["dev", "--", "--account", "inner"],
			GateFlagRegion.WITH_LEADING_SLOT,
		);

		expect(split.accountLabel).toBeUndefined();
		expect(split.nativeArgs).toEqual(["dev", "--", "--account", "inner"]);
	});

	it("treats empty-string values as no account given", () => {
		expect(
			splitGateFlags(
				vercelLike,
				["-a", "", "deploy"],
				GateFlagRegion.WITH_LEADING_SLOT,
			).accountLabel,
		).toBeUndefined();

		expect(
			splitGateFlags(
				vercelLike,
				["--account=", "deploy"],
				GateFlagRegion.WITH_LEADING_SLOT,
			).accountLabel,
		).toBeUndefined();
	});

	it("flags a missing or flag-like value as malformed", () => {
		expect(
			splitGateFlags(
				vercelLike,
				["-a", "--account", "deploy"],
				GateFlagRegion.WITH_LEADING_SLOT,
			).malformed,
		).toContain("-a requires a value");

		expect(
			splitGateFlags(
				vercelLike,
				["env", "ls", "--account"],
				GateFlagRegion.WITH_LEADING_SLOT,
			).malformed,
		).toContain("--account requires a value");
	});

	it("handles empty args", () => {
		expect(
			splitGateFlags(vercelLike, [], GateFlagRegion.WITH_LEADING_SLOT),
		).toEqual({
			accountLabel: undefined,
			targetName: undefined,
			nativeArgs: [],
			malformed: undefined,
		});
	});
});

describe("splitGateFlags NATIVE_REGION_ONLY", () => {
	it("never extracts a reserved -a, even at position zero", () => {
		const split = splitGateFlags(
			flyLike,
			["-a", "my-app", "--image", "x"],
			GateFlagRegion.NATIVE_REGION_ONLY,
		);

		expect(split.accountLabel).toBeUndefined();
		expect(split.nativeArgs).toEqual(["-a", "my-app", "--image", "x"]);
	});

	it("still extracts the long form anywhere", () => {
		const split = splitGateFlags(
			flyLike,
			["-a", "my-app", "--account", "work"],
			GateFlagRegion.NATIVE_REGION_ONLY,
		);

		expect(split.accountLabel).toBe("work");
		expect(split.nativeArgs).toEqual(["-a", "my-app"]);
	});

	it("still extracts an unreserved -a anywhere", () => {
		const split = splitGateFlags(
			vercelLike,
			["--prod", "-a", "work"],
			GateFlagRegion.NATIVE_REGION_ONLY,
		);

		expect(split.accountLabel).toBe("work");
		expect(split.nativeArgs).toEqual(["--prod"]);
	});
});

describe("splitGateFlags target flag", () => {
	it("extracts --project and --project= anywhere in WITH_LEADING_SLOT", () => {
		expect(
			splitGateFlags(
				targeting,
				["env", "ls", "--project", "hat-rec"],
				GateFlagRegion.WITH_LEADING_SLOT,
			),
		).toEqual({
			accountLabel: undefined,
			targetName: "hat-rec",
			nativeArgs: ["env", "ls"],
			malformed: undefined,
		});

		expect(
			splitGateFlags(
				targeting,
				["--project=hat-rec", "env", "ls"],
				GateFlagRegion.WITH_LEADING_SLOT,
			),
		).toEqual({
			accountLabel: undefined,
			targetName: "hat-rec",
			nativeArgs: ["env", "ls"],
			malformed: undefined,
		});
	});

	it("never extracts the target flag in NATIVE_REGION_ONLY (deploy keeps it native)", () => {
		const split = splitGateFlags(
			targeting,
			["--prod", "--project", "hat-rec"],
			GateFlagRegion.NATIVE_REGION_ONLY,
		);

		expect(split.targetName).toBeUndefined();
		expect(split.nativeArgs).toEqual(["--prod", "--project", "hat-rec"]);
	});

	it("does not recognize the flag when the capability is absent", () => {
		const split = splitGateFlags(
			vercelLike,
			["env", "ls", "--project", "hat-rec"],
			GateFlagRegion.WITH_LEADING_SLOT,
		);

		expect(split.targetName).toBeUndefined();
		expect(split.nativeArgs).toEqual(["env", "ls", "--project", "hat-rec"]);
	});

	it("treats empty values as not given and flag-like values as malformed", () => {
		expect(
			splitGateFlags(
				targeting,
				["--project=", "env"],
				GateFlagRegion.WITH_LEADING_SLOT,
			).targetName,
		).toBeUndefined();

		expect(
			splitGateFlags(
				targeting,
				["env", "--project"],
				GateFlagRegion.WITH_LEADING_SLOT,
			).malformed,
		).toContain("--project requires a value");
	});

	it("leaves the flag untouched after --", () => {
		const split = splitGateFlags(
			targeting,
			["--", "--project", "hat-rec"],
			GateFlagRegion.WITH_LEADING_SLOT,
		);

		expect(split.targetName).toBeUndefined();
		expect(split.nativeArgs).toEqual(["--", "--project", "hat-rec"]);
	});

	it("extracts account and target together in the leading slot", () => {
		const split = splitGateFlags(
			targeting,
			["-a", "work", "--project", "hat-rec", "env", "ls"],
			GateFlagRegion.WITH_LEADING_SLOT,
		);

		expect(split.accountLabel).toBe("work");
		expect(split.targetName).toBe("hat-rec");
		expect(split.nativeArgs).toEqual(["env", "ls"]);
	});
});
