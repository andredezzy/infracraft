import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./base";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			include: ["src/**/*.e2e-test.ts"],
			exclude: ["**/node_modules/**", "**/dist/**"],
			setupFiles: ["@infracraft/config-test/setup"],
			testTimeout: 120000,
			hookTimeout: 60000,
			teardownTimeout: 30000,
			fileParallelism: false,
			sequence: {
				concurrent: false,
			},
			passWithNoTests: true,
		},
	}),
);
