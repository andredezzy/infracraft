import type { UserConfig } from "tsdown";

export const TEST_EXCLUSIONS = [
	"!**/*.test.ts",
	"!**/*.test.tsx",
	"!**/*.e2e-test.ts",
	"!**/*.e2e-test.tsx",
] as const;

export const baseConfig: UserConfig = {
	format: "esm",
	clean: true,
	treeshake: true,
	sourcemap: true,
	dts: { sourcemap: true },
	outputOptions: { keepNames: true },
};
