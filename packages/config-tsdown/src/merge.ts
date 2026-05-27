import type { UserConfig } from "tsdown";

export function mergeConfig(...configs: UserConfig[]): UserConfig {
	const result: UserConfig = {};

	for (const config of configs) {
		for (const key of Object.keys(config) as (keyof UserConfig)[]) {
			const value = config[key];
			const existing = result[key];

			if (value === undefined) {
				continue;
			}

			if (Array.isArray(value) && Array.isArray(existing)) {
				result[key] = Array.from(new Set([...existing, ...value])) as never;
			} else if (
				typeof value === "object" &&
				value !== null &&
				typeof existing === "object" &&
				existing !== null &&
				!Array.isArray(value)
			) {
				result[key] = { ...existing, ...value } as never;
			} else {
				result[key] = value as never;
			}
		}
	}

	return result;
}
