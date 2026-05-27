import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./base";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			include: ["src/**/*.test.ts", "test/**/*.test.ts"],
			exclude: ["**/node_modules/**", "**/dist/**", "**/*.e2e-test.ts"],
			setupFiles: ["@infracraft/config-test/setup"],
			passWithNoTests: true,
		},
	}),
);
