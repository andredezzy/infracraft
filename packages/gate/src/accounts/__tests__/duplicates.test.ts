import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import type { GateProvider } from "../../providers/provider";
import { Provider } from "../../providers/provider";
import { findDuplicateIdentityGroups } from "../duplicates";
import { AccountStore } from "../store";

let store: AccountStore;

const provider = { id: Provider.VERCEL } as GateProvider;

function seed(label: string, identity: string): void {
	store.add({
		provider: Provider.VERCEL,
		label,
		identity,
		session: { token: `tok-${label}` },
	});
}

beforeEach(() => {
	store = new AccountStore(
		fs.mkdtempSync(path.join(os.tmpdir(), "gate-duplicates-")),
	);
});

describe("findDuplicateIdentityGroups", () => {
	it("returns [] when every identity is unique", () => {
		seed("a", "andre");
		seed("b", "bob");

		expect(findDuplicateIdentityGroups(provider, store)).toEqual([]);
	});

	it("returns one group for one duplicated identity, in stored order", () => {
		seed("hc", "crew");
		seed("dz0", "dz");
		seed("hat", "crew");

		const groups = findDuplicateIdentityGroups(provider, store);

		expect(groups).toHaveLength(1);
		expect(groups[0]?.map((account) => account.label)).toEqual(["hc", "hat"]);
	});

	it("returns multiple groups", () => {
		seed("a1", "andre");
		seed("a2", "andre");
		seed("b1", "bob");
		seed("b2", "bob");

		const groups = findDuplicateIdentityGroups(provider, store);

		expect(groups).toHaveLength(2);
	});

	it("is provider-scoped", () => {
		seed("a", "andre");

		store.add({
			provider: Provider.RAILWAY,
			label: "rw",
			identity: "andre",
			session: { token: "t" },
		});

		expect(findDuplicateIdentityGroups(provider, store)).toEqual([]);
	});
});
