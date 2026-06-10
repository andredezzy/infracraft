import { describe, expect, it } from "vitest";

import { GateAuthVerb } from "../../routing/route-command";
import { buildRegistry } from "../command-registry";

describe("buildRegistry", () => {
	it("registers every auth verb in enum order", () => {
		const registry = buildRegistry();

		expect([...registry.authVerbs.keys()]).toEqual(Object.values(GateAuthVerb));
	});

	it("every spec has a description, usage, and run", () => {
		const registry = buildRegistry();

		for (const spec of registry.authVerbs.values()) {
			expect(spec.description.length).toBeGreaterThan(0);
			expect(typeof spec.run).toBe("function");
		}

		expect(registry.deploySpec.description).toContain("deploy");
	});
});
