import { defineConfig } from "tsdown";

export default defineConfig({
	entry: [
		"src/**/*.ts",
		"!src/**/*.test.ts",
		"!src/**/*.test.tsx",
		"!src/**/*.e2e-test.ts",
		"!src/**/*.e2e-test.tsx",
	],
	format: ["esm", "cjs"],
	clean: true,
	treeshake: true,
	minify: true,
	dts: { sourcemap: true },
});
