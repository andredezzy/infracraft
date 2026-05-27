import { baseConfig } from "@infrakit/config-tsdown/base";
import { mergeConfig } from "@infrakit/config-tsdown/merge";

export default [
	mergeConfig(baseConfig, {
		entry: ["src/base.ts", "src/unit.ts", "src/e2e.ts"],
		format: ["esm", "cjs"],
		minify: true,
		external: ["vitest", "vitest/config", "unplugin-swc"],
	}),
	mergeConfig(baseConfig, {
		entry: ["src/setup.ts"],
		format: "esm",
		minify: true,
		external: ["vitest", "vitest/config"],
	}),
];
