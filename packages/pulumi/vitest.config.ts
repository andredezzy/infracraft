import unit from "@infracraft/config-test/unit";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
	unit,
	defineConfig({
		test: {
			exclude: ["**/node_modules/**", "**/dist/**", "**/*.drift.test.ts"],
		},
	}),
);
