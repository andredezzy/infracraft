import { frameworks } from "@vercel/frameworks";
import { describe, expect, it } from "vitest";
import { VERCEL_FRAMEWORKS } from "../project";

/**
 * Drift test: asserts that VERCEL_FRAMEWORKS matches the slug list from
 * the installed @vercel/frameworks package.
 *
 * Unlike the other drift tests this test is fully offline — it imports the
 * devDependency directly. It will fail when @vercel/frameworks is bumped
 * and a new framework slug appears or an old one is removed.
 *
 * Run with: bun run test:drift
 */
describe("VERCEL_FRAMEWORKS drift", () => {
	it("matches the slug list from @vercel/frameworks", () => {
		// Filter out null slugs — some @vercel/frameworks entries represent
		// "no framework" (e.g. static sites) and have a null slug by design.
		const upstreamSlugs = new Set(
			frameworks.map((f) => f.slug).filter((s): s is string => s !== null),
		);

		const localSlugs = new Set(VERCEL_FRAMEWORKS);

		const added = [...upstreamSlugs].filter((s) => !localSlugs.has(s));
		const removed = [...localSlugs].filter((s) => !upstreamSlugs.has(s));

		expect(
			added,
			`@vercel/frameworks added slugs not in VERCEL_FRAMEWORKS: ${added.join(", ")}`,
		).toHaveLength(0);

		expect(
			removed,
			`VERCEL_FRAMEWORKS has slugs no longer in @vercel/frameworks: ${removed.join(", ")}`,
		).toHaveLength(0);
	});
});
