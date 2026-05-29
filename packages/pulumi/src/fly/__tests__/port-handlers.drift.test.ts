import { describe, expect, it } from "vitest";
import { FlyPortHandler } from "../toml";

/**
 * Drift test: asserts that FlyPortHandler enum values match the
 * ServiceHandlerType enum in the Fly GraphQL API.
 *
 * Run with: bun run test:drift
 */
describe("FlyPortHandler drift", () => {
	it("matches ServiceHandlerType enum values in Fly GraphQL API", async () => {
		const url = "https://api.fly.io/graphql";

		const query = `
      {
        __type(name: "ServiceHandlerType") {
          enumValues {
            name
          }
        }
      }
    `;

		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query }),
		});

		expect(response.ok, `Failed to fetch ${url}: ${response.status}`).toBe(
			true,
		);

		const json = (await response.json()) as {
			data?: { __type?: { enumValues?: Array<{ name: string }> } };
		};

		const enumValues = json.data?.__type?.enumValues;

		expect(
			enumValues,
			`ServiceHandlerType enum not found in Fly GraphQL schema — response: ${JSON.stringify(json)}`,
		).toBeDefined();

		// Fly GraphQL returns UPPERCASE names; local enum values are lowercase wire literals.
		const upstreamHandlers = new Set(
			(enumValues ?? []).map((v) => v.name.toLowerCase()),
		);

		const localHandlers = new Set(Object.values(FlyPortHandler));

		const added = [...upstreamHandlers].filter((h) => !localHandlers.has(h));
		const removed = [...localHandlers].filter((h) => !upstreamHandlers.has(h));

		expect(
			added,
			`Upstream added handler types not in FlyPortHandler: ${added.join(", ")}`,
		).toHaveLength(0);

		expect(
			removed,
			`FlyPortHandler has values no longer in upstream ServiceHandlerType: ${removed.join(", ")}`,
		).toHaveLength(0);
	});
});
