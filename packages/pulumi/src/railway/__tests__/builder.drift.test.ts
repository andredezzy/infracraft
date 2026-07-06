import { describe, expect, it } from "vitest";
import { Builder, RestartPolicy } from "../service";

/**
 * Drift test: asserts that Builder and RestartPolicy enum values
 * match the Railway JSON schema at backboard.railway.app.
 *
 * Run with: bun run test:drift
 */

/** Railway schema fields use anyOf: [{type:string, enum:[...]}, {type:null}] */
interface SchemaField {
	anyOf?: Array<{ type: string; enum?: string[] }>;
	enum?: string[];
}

/** Extract enum values from a Railway schema field (handles both direct and anyOf patterns). */
function extractEnum(field: SchemaField): string[] | undefined {
	if (field.enum) {
		return field.enum;
	}

	if (field.anyOf) {
		for (const variant of field.anyOf) {
			if (variant.type === "string" && variant.enum) {
				return variant.enum;
			}
		}
	}

	return undefined;
}

describe("Railway enum drift", () => {
	it("railway.Builder matches railway.schema.json build.builder enum", async () => {
		const url = "https://backboard.railway.app/railway.schema.json";

		const response = await fetch(url);

		expect(response.ok, `Failed to fetch ${url}: ${response.status}`).toBe(
			true,
		);

		const schema = (await response.json()) as {
			properties?: {
				build?: {
					properties?: {
						builder?: SchemaField;
					};
				};
			};
		};

		const builderField = schema.properties?.build?.properties?.builder;

		expect(
			builderField,
			"build.builder field not found in Railway schema — schema may have changed",
		).toBeDefined();

		const upstreamBuilders = extractEnum(builderField ?? {});

		expect(
			upstreamBuilders,
			"build.builder enum values not found in Railway schema — schema structure may have changed",
		).toBeDefined();

		const upstreamSet = new Set(upstreamBuilders ?? []);
		const localSet = new Set(Object.values(Builder));

		const added = [...upstreamSet].filter((v) => !localSet.has(v as Builder));

		const removed = [...localSet].filter((v) => !upstreamSet.has(v));

		expect(
			added,
			`Upstream added builder values not in railway.Builder: ${added.join(", ")}`,
		).toHaveLength(0);

		expect(
			removed,
			`railway.Builder has values no longer in upstream schema: ${removed.join(", ")}`,
		).toHaveLength(0);
	});

	it("railway.RestartPolicy matches railway.schema.json deploy.restartPolicyType enum", async () => {
		const url = "https://backboard.railway.app/railway.schema.json";

		const response = await fetch(url);

		expect(response.ok, `Failed to fetch ${url}: ${response.status}`).toBe(
			true,
		);

		const schema = (await response.json()) as {
			properties?: {
				deploy?: {
					properties?: {
						restartPolicyType?: SchemaField;
					};
				};
			};
		};

		const restartField =
			schema.properties?.deploy?.properties?.restartPolicyType;

		expect(
			restartField,
			"deploy.restartPolicyType field not found in Railway schema — schema may have changed",
		).toBeDefined();

		const upstreamPolicies = extractEnum(restartField ?? {});

		expect(
			upstreamPolicies,
			"deploy.restartPolicyType enum values not found in Railway schema — schema structure may have changed",
		).toBeDefined();

		const upstreamSet = new Set(upstreamPolicies ?? []);
		const localSet = new Set(Object.values(RestartPolicy));

		const added = [...upstreamSet].filter(
			(v) => !localSet.has(v as RestartPolicy),
		);

		const removed = [...localSet].filter((v) => !upstreamSet.has(v));

		expect(
			added,
			`Upstream added restart policy values not in railway.RestartPolicy: ${added.join(", ")}`,
		).toHaveLength(0);

		expect(
			removed,
			`railway.RestartPolicy has values no longer in upstream schema: ${removed.join(", ")}`,
		).toHaveLength(0);
	});
});
