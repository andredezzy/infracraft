import { describe, expect, it } from "vitest";
import { FLY_VM_SIZES } from "../toml";

/**
 * Drift test: asserts that FLY_VM_SIZES matches the keys of MachinePresets
 * in superfly/fly-go. Fetches the upstream Go source to detect added/removed sizes.
 *
 * Run with: bun run test:drift
 */
describe("FLY_VM_SIZES drift", () => {
	it("matches the MachinePresets keys in superfly/fly-go", async () => {
		const url =
			"https://raw.githubusercontent.com/superfly/fly-go/main/machine_types.go";

		const response = await fetch(url);

		expect(response.ok, `Failed to fetch ${url}: ${response.status}`).toBe(
			true,
		);

		const source = await response.text();

		// Parse string keys from the MachinePresets map literal.
		// The declaration looks like:
		//   var MachinePresets map[string]*MachineGuest = map[string]*MachineGuest{
		//     "shared-cpu-1x": {CPUKind: "shared", CPUs: 1, ...},
		//     ...
		//   }
		// Locate the opening `{` of the map literal by finding the full declaration,
		// then collect the `"key":` entries inside.
		const mapDecl =
			"MachinePresets map[string]*MachineGuest = map[string]*MachineGuest{";
		const declIndex = source.indexOf(mapDecl);

		expect(
			declIndex,
			"MachinePresets declaration not found — upstream file structure may have changed",
		).toBeGreaterThan(-1);

		// bodyStart points at the opening `{` of the map literal
		const bodyStart = declIndex + mapDecl.length - 1;
		const bodyEnd = source.indexOf("\n}", bodyStart);
		const mapBody = source.slice(bodyStart, bodyEnd + 2);

		// Each key is a quoted string at the start of a line (with optional tabs)
		const keyPattern = /^\s*"([^"]+)":/gm;
		const upstreamSizes = new Set<string>();

		for (const match of mapBody.matchAll(keyPattern)) {
			upstreamSizes.add(match[1]);
		}

		expect(
			upstreamSizes.size,
			"No MachinePresets keys found — regex may need updating",
		).toBeGreaterThan(0);

		const localSizes = new Set(FLY_VM_SIZES);

		const added = [...upstreamSizes].filter((s) => !localSizes.has(s));
		const removed = [...localSizes].filter((s) => !upstreamSizes.has(s));

		expect(
			added,
			`Upstream added VM sizes not in FLY_VM_SIZES: ${added.join(", ")}`,
		).toHaveLength(0);

		expect(
			removed,
			`FLY_VM_SIZES has sizes no longer in upstream MachinePresets: ${removed.join(", ")}`,
		).toHaveLength(0);
	});
});
