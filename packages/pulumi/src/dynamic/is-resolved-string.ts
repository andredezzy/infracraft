import * as pulumi from "@pulumi/pulumi";

/**
 * True when a dynamic-provider input holds a concrete string — neither
 * `undefined` nor Pulumi's preview "unknown" sentinel. `check()` runs at plan
 * time, when an input fed by another resource's output may still be
 * unresolved; validation must skip those values instead of failing on the
 * sentinel.
 */
export function isResolvedString(value: unknown): value is string {
	return typeof value === "string" && value !== pulumi.runtime.unknownValue;
}
