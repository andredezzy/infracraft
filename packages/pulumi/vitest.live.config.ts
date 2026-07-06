import base from "@infracraft/config-test/base";
import { defineConfig, mergeConfig } from "vitest/config";

/**
 * Live integration tier: runs the resource providers against REAL platform APIs,
 * creating and tearing down throwaway resources. Opt-in only — every `*.live.test.ts`
 * self-skips unless `INFRACRAFT_LIVE_TEST=1` and its platform credentials are set,
 * so this config exits 0 with everything skipped when run without creds.
 *
 * Built on `base` (NOT `unit`): the unit setup mocks `Bun`, which live tests must
 * not have. It is intentionally absent from the default `test` script and from CI.
 *
 * Run with: bun run test:live
 */
export default mergeConfig(
	base,
	defineConfig({
		test: {
			include: ["src/**/*.live.test.ts"],
			exclude: ["**/node_modules/**", "**/dist/**"],
			// Real deploys, env forks, and Neon async operations are slow; give them room.
			testTimeout: 180_000,
			hookTimeout: 180_000,
			teardownTimeout: 120_000,
			// Live files mutate shared throwaway projects — run them serially, never in parallel.
			fileParallelism: false,
			sequence: {
				concurrent: false,
			},
		},
	}),
);
