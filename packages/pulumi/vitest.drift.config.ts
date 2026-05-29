import base from "@infracraft/config-test/base";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
	base,
	defineConfig({
		test: {
			include: ["src/**/*.drift.test.ts"],
			testTimeout: 30000,
		},
	}),
);
