import { describe, expect, it } from "vitest";

import { makeFakeProvider } from "../../providers/__tests__/fake-provider";
import { CommandRoute, GateAuthVerb, routeCommand } from "../route-command";

const provider = makeFakeProvider();
const railwayLike = makeFakeProvider({ deployVerb: "up" });
const flyLike = makeFakeProvider({ reservedNativeFlags: ["-a"] });

describe("routeCommand GATE_TREE", () => {
	it("routes empty args to the gate tree", () => {
		expect(routeCommand(provider, [])).toEqual({
			route: CommandRoute.GATE_TREE,
			gateArgs: [],
		});
	});

	it("routes a sole --help / -h / --version to the gate tree", () => {
		for (const token of ["--help", "-h", "--version"]) {
			expect(routeCommand(provider, [token])).toEqual({
				route: CommandRoute.GATE_TREE,
				gateArgs: [token],
			});
		}
	});

	it("routes auth + every gate verb to the gate tree", () => {
		for (const verb of Object.values(GateAuthVerb)) {
			expect(routeCommand(provider, ["auth", verb])).toEqual({
				route: CommandRoute.GATE_TREE,
				gateArgs: ["auth", verb],
			});
		}
	});

	it("routes bare auth to the gate tree", () => {
		expect(routeCommand(provider, ["auth"])).toEqual({
			route: CommandRoute.GATE_TREE,
			gateArgs: ["auth"],
		});
	});

	it("routes auth --help to the gate tree", () => {
		expect(routeCommand(provider, ["auth", "--help"])).toEqual({
			route: CommandRoute.GATE_TREE,
			gateArgs: ["auth", "--help"],
		});
	});

	it("routes the provider deploy verb to the gate tree", () => {
		expect(routeCommand(provider, ["deploy", "--prod"])).toEqual({
			route: CommandRoute.GATE_TREE,
			gateArgs: ["deploy", "--prod"],
		});

		expect(routeCommand(railwayLike, ["up", "--detach"])).toEqual({
			route: CommandRoute.GATE_TREE,
			gateArgs: ["up", "--detach"],
		});
	});

	it("re-injects a leading account after the deploy verb (both flag forms)", () => {
		expect(routeCommand(provider, ["-a", "work", "deploy", "--prod"])).toEqual({
			route: CommandRoute.GATE_TREE,
			gateArgs: ["deploy", "--prod", "--account", "work"],
		});

		expect(
			routeCommand(provider, ["--account=work", "deploy", "--prod"]),
		).toEqual({
			route: CommandRoute.GATE_TREE,
			gateArgs: ["deploy", "--prod", "--account", "work"],
		});
	});

	it("re-injects a leading --project after the deploy verb", () => {
		const targeting = makeFakeProvider({
			passthroughTarget: {
				flag: "--project",
				noun: "project",
				resolveEnv: async () => ({}),
			},
		});

		expect(
			routeCommand(targeting, ["--project", "hat-rec", "deploy", "--prod"]),
		).toEqual({
			route: CommandRoute.GATE_TREE,
			gateArgs: ["deploy", "--prod", "--project", "hat-rec"],
		});
	});
});

describe("routeCommand PASSTHROUGH", () => {
	it("routes unknown verbs with extracted account flags", () => {
		expect(routeCommand(provider, ["env", "ls", "-a", "work"])).toEqual({
			route: CommandRoute.PASSTHROUGH,
			nativeArgs: ["env", "ls"],
			accountLabel: "work",
			targetName: undefined,
			movedVerbHint: undefined,
		});
	});

	it("routes leading native flags to passthrough", () => {
		const routed = routeCommand(provider, ["--cwd", "x", "ls"]);

		expect(routed.route).toBe(CommandRoute.PASSTHROUGH);
	});

	it("keeps native auth subcommand help requests native", () => {
		expect(routeCommand(flyLike, ["auth", "token", "--help"])).toEqual({
			route: CommandRoute.PASSTHROUGH,
			nativeArgs: ["auth", "token", "--help"],
			accountLabel: undefined,
			targetName: undefined,
			movedVerbHint: undefined,
		});
	});

	it("routes auth + non-gate verbs natively (fly auth token)", () => {
		expect(routeCommand(flyLike, ["auth", "token"])).toEqual({
			route: CommandRoute.PASSTHROUGH,
			nativeArgs: ["auth", "token"],
			accountLabel: undefined,
			targetName: undefined,
			movedVerbHint: undefined,
		});
	});

	it("keeps a reserved -a native while honoring the leading slot", () => {
		expect(
			routeCommand(flyLike, ["-a", "work", "status", "-a", "my-app"]),
		).toEqual({
			route: CommandRoute.PASSTHROUGH,
			nativeArgs: ["status", "-a", "my-app"],
			accountLabel: "work",
			targetName: undefined,
			movedVerbHint: undefined,
		});
	});

	it("a leading -- escapes verbatim; gate flags before it still apply", () => {
		expect(routeCommand(provider, ["--", "switch", "my-team"])).toEqual({
			route: CommandRoute.PASSTHROUGH,
			nativeArgs: ["switch", "my-team"],
			accountLabel: undefined,
			targetName: undefined,
			movedVerbHint: undefined,
		});

		expect(
			routeCommand(provider, ["-a", "work", "--", "-a", "native"]),
		).toEqual({
			route: CommandRoute.PASSTHROUGH,
			nativeArgs: ["-a", "native"],
			accountLabel: "work",
			targetName: undefined,
			movedVerbHint: undefined,
		});
	});

	it("flags moved gate verbs for the hint", () => {
		const routed = routeCommand(provider, ["login"]);

		expect(routed).toEqual({
			route: CommandRoute.PASSTHROUGH,
			nativeArgs: ["login"],
			accountLabel: undefined,
			targetName: undefined,
			movedVerbHint: GateAuthVerb.LOGIN,
		});
	});

	it("carries the extracted target name", () => {
		const targeting = makeFakeProvider({
			passthroughTarget: {
				flag: "--project",
				noun: "project",
				resolveEnv: async () => ({}),
			},
		});

		expect(
			routeCommand(targeting, ["env", "ls", "--project", "hat-rec"]),
		).toEqual({
			route: CommandRoute.PASSTHROUGH,
			nativeArgs: ["env", "ls"],
			accountLabel: undefined,
			targetName: "hat-rec",
			movedVerbHint: undefined,
		});
	});
});

describe("routeCommand INVALID", () => {
	it("rejects account flags on auth verbs with guidance", () => {
		const routed = routeCommand(provider, ["-a", "work", "auth", "switch"]);

		expect(routed.route).toBe(CommandRoute.INVALID);

		expect(
			routed.route === CommandRoute.INVALID ? routed.message : "",
		).toContain("auth");
	});

	it("renders help instead when --help rides along", () => {
		expect(
			routeCommand(provider, ["-a", "work", "auth", "switch", "--help"]),
		).toEqual({
			route: CommandRoute.GATE_TREE,
			gateArgs: ["auth", "switch", "--help"],
		});
	});

	it("rejects a target flag on auth verbs", () => {
		const targeting = makeFakeProvider({
			passthroughTarget: {
				flag: "--project",
				noun: "project",
				resolveEnv: async () => ({}),
			},
		});

		const routed = routeCommand(targeting, [
			"--project",
			"hat-rec",
			"auth",
			"switch",
		]);

		expect(routed.route).toBe(CommandRoute.INVALID);
	});

	it("rejects malformed gate flags", () => {
		const routed = routeCommand(provider, ["-a", "--account", "deploy"]);

		expect(routed.route).toBe(CommandRoute.INVALID);
	});

	it("rejects gate flags with nothing to run", () => {
		const routed = routeCommand(provider, ["-a", "work"]);

		expect(routed.route).toBe(CommandRoute.INVALID);
	});
});
