import { describe, expect, it } from "vitest";

import { makeFakeProvider } from "../../providers/__tests__/fake-provider";
import { GateFlagRegion, splitGateFlags } from "../split-gate-flags";

const vercelLike = makeFakeProvider();
const flyLike = makeFakeProvider({ reservedNativeFlags: ["-a"] });

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
